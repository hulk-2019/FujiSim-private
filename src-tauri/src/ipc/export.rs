//! 批量导出任务调度、执行和管理。

use crate::db::tasks;
use crate::error::{AppError, Result};
use crate::export::{self, ExportSettings};
use crate::processing::{lut::Lut3D, FilterSettings};
use crate::state::SharedState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, State};

/// 每个资产对应的水印层。
#[derive(Debug, Deserialize)]
pub struct PerAssetWatermark {
    pub asset_id: i64,
    pub layer: export::WatermarkLayer,
}

/// 批量导出请求体。每个 asset_id 将创建一条独立的 batch_tasks 记录。
#[derive(Debug, Deserialize)]
pub struct BatchExportRequest {
    pub asset_ids: Vec<i64>,
    pub filter: FilterSettings,
    pub export: ExportSettings,
    /// 每个资产对应的水印层（按资产实际尺寸预渲染），None 表示不叠加水印。
    pub per_asset_watermark: Option<Vec<PerAssetWatermark>>,
    /// 水印设置（不含 base64 图像），用于持久化到 batch_tasks 表。
    pub watermark_settings: Option<serde_json::Value>,
}

/// 批量任务进度事件。通过 `app.emit("export:progress", &progress)` 推送给前端。
///
/// `done=true` 表示整批结束（成功+失败 == 总数），前端据此关闭进度条。
#[derive(Debug, Serialize, Clone)]
pub struct BatchProgress {
    pub task_id: i64,
    pub total: i64,
    pub completed: i64,
    pub failed: i64,
    pub last_asset_id: Option<i64>,
    pub last_output: Option<String>,
    pub last_error: Option<String>,
    pub done: bool,
}

/// 启动一次批量导出。
///
/// 在数据库中创建状态为 `pending` 的任务，立即推送进度事件让前端感知，
/// 然后调用 `dispatch_pending` 尝试填充空闲并发槽位。
/// 启动一次批量导出。
/// 每个 asset_id 创建一条独立的 batch_tasks 记录，返回所有新建的 task_id 列表。
#[tauri::command]
pub async fn start_batch_export(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    request: BatchExportRequest,
) -> Result<Vec<i64>> {
    let filter_json = serde_json::to_string(&request.filter)?;
    let export_json = serde_json::to_string(&request.export)?;
    let watermark_json = request
        .watermark_settings
        .as_ref()
        .and_then(|w| serde_json::to_string(w).ok());

    // 每个资产按自己的水印层单独创建任务，各自保存水印文件
    let mut task_ids: Vec<i64> = Vec::with_capacity(request.asset_ids.len());
    for &asset_id in &request.asset_ids {
        let task_id = tasks::create(
            &state.pool,
            asset_id,
            &export_json,
            &filter_json,
            watermark_json.as_deref(),
            None,
        )
        .await?;

        // 查找该 asset 对应的水印层并保存到磁盘
        let watermark_layer = request
            .per_asset_watermark
            .as_ref()
            .and_then(|list| list.iter().find(|e| e.asset_id == asset_id))
            .map(|e| &e.layer);
        if let Some(path) = save_watermark_layer(watermark_layer, &state.watermark_dir, task_id)? {
            let path_str = path.to_string_lossy().to_string();
            sqlx::query("UPDATE batch_tasks SET watermark_layer_path = ? WHERE id = ?")
                .bind(&path_str)
                .bind(task_id)
                .execute(&state.pool)
                .await?;
        }

        task_ids.push(task_id);
    }

    // 推送所有任务的初始 pending 进度
    for &task_id in &task_ids {
        let _ = app.emit(
            "export:progress",
            &BatchProgress {
                task_id,
                total: 1,
                completed: 0,
                failed: 0,
                last_asset_id: None,
                last_output: None,
                last_error: None,
                done: false,
            },
        );
    }

    // 立即填满队列空位
    dispatch_pending(state.inner().clone(), app).await;

    Ok(task_ids)
}

/// 从数据库取出 pending 任务填充空闲并发槽位。
async fn dispatch_pending(state: SharedState, app: tauri::AppHandle) {
    while state.task_queue.try_acquire() {
        let task = match tasks::claim_next_pending(&state.pool).await {
            Ok(Some(t)) => t,
            _ => {
                // 没有 pending 任务，归还刚占用的槽位
                state.task_queue.on_task_finish(-1);
                break;
            }
        };

        let task_id = task.id;
        let asset_id = task.asset_id;
        let filter: FilterSettings = match serde_json::from_str(&task.filter_settings_json) {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(task_id, error = %e, "dispatch_pending: bad filter_json");
                let _ = tasks::finish(&state.pool, task_id).await;
                state.task_queue.on_task_finish(task_id);
                continue;
            }
        };
        let export_settings: ExportSettings = match serde_json::from_str(&task.export_settings_json)
        {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(task_id, error = %e, "dispatch_pending: bad export_json");
                let _ = tasks::finish(&state.pool, task_id).await;
                state.task_queue.on_task_finish(task_id);
                continue;
            }
        };
        let lut = match super::cached_lut(&state, filter.lut_file_path.as_deref()) {
            Ok(l) => l,
            Err(e) => {
                tracing::error!(task_id, error = %e, "dispatch_pending: lut load failed");
                let _ = tasks::finish(&state.pool, task_id).await;
                state.task_queue.on_task_finish(task_id);
                continue;
            }
        };
        let watermark_path: Option<PathBuf> =
            task.watermark_layer_path.as_deref().map(PathBuf::from);

        // try_acquire 已经递增了计数器，无需再调用 on_task_start
        run_export_task(
            state.clone(),
            app.clone(),
            task_id,
            asset_id,
            filter,
            export_settings,
            lut,
            watermark_path,
        );
    }
}

/// 估算单次导出任务的内存占用（MB）。
/// RAW 解码后约为文件大小的 7 倍（16-bit RGB 展开），最低 50MB。
fn estimate_export_memory_mb(file_size_bytes: i64) -> u64 {
    let raw_mb = (file_size_bytes / 1024 / 1024) as u64;
    (raw_mb * 7).max(50)
}

/// 在 spawn_blocking 线程中执行单个资产的导出任务，完成后调度下一个 pending 任务。
#[allow(clippy::too_many_arguments)]
fn run_export_task(
    state: SharedState,
    app: tauri::AppHandle,
    task_id: i64,
    asset_id: i64,
    filter: FilterSettings,
    export_settings: ExportSettings,
    lut: Option<Arc<Lut3D>>,
    watermark_path: Option<PathBuf>,
) {
    tokio::task::spawn_blocking(move || {
        let pool = state.pool.clone();
        let rt = tokio::runtime::Handle::current();

        let _ = app.emit(
            "export:progress",
            &BatchProgress {
                task_id,
                total: 1,
                completed: 0,
                failed: 0,
                last_asset_id: None,
                last_output: None,
                last_error: None,
                done: false,
            },
        );

        if state.task_queue.is_cancelled(task_id) {
            let _ = rt.block_on(crate::db::tasks::finish(&pool, task_id));
            state.task_queue.on_task_finish(task_id);
            rt.spawn(async move {
                dispatch_pending(state, app).await;
            });
            return;
        }

        let asset = match rt.block_on(crate::db::assets::get(&pool, asset_id)) {
            Ok(a) => a,
            Err(e) => {
                tracing::error!(task_id, asset_id, error = %e, "run_export_task: asset not found");
                let _ = rt.block_on(crate::db::tasks::finish(&pool, task_id));
                cleanup_watermark_file(&state.watermark_dir, task_id);
                state.task_queue.on_task_finish(task_id);
                rt.spawn(async move {
                    dispatch_pending(state, app).await;
                });
                return;
            }
        };

        let needed_mb = estimate_export_memory_mb(asset.file_size.unwrap_or(30 * 1024 * 1024));

        // 等待内存预算（最多 30s），CAS 扣减
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let current = state
                .export_memory_budget
                .load(std::sync::atomic::Ordering::SeqCst);
            if current >= needed_mb
                && state
                    .export_memory_budget
                    .compare_exchange(
                        current,
                        current - needed_mb,
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst,
                    )
                    .is_ok()
            {
                break;
            }
            if std::time::Instant::now() > deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }

        let src_path = std::path::PathBuf::from(&asset.file_path);

        // 在 export_pool 内执行，确保 process_image 的 rayon 并行使用受控线程池
        // 而非全局线程池，避免导出任务占满所有 CPU 核心
        let result: Result<PathBuf> = state.export_pool.install(|| {
            export::resolve_destination_dir(&src_path, &export_settings.destination).and_then(
                |dest| {
                    export::export_one(
                        &src_path,
                        &dest,
                        &filter,
                        &export_settings,
                        lut.as_deref(),
                        watermark_path.as_deref(),
                    )
                },
            )
        });

        // 归还内存预算
        state
            .export_memory_budget
            .fetch_add(needed_mb, std::sync::atomic::Ordering::SeqCst);

        match &result {
            Ok(out) => {
                let _ = rt.block_on(crate::db::tasks::record_generation(
                    &pool,
                    task_id,
                    asset_id,
                    Some(out.to_string_lossy().as_ref()),
                    "Success",
                    None,
                ));
                let _ = app.emit(
                    "export:progress",
                    &BatchProgress {
                        task_id,
                        total: 1,
                        completed: 1,
                        failed: 0,
                        last_asset_id: Some(asset_id),
                        last_output: Some(out.to_string_lossy().to_string()),
                        last_error: None,
                        done: false,
                    },
                );
            }
            Err(e) => {
                let msg = e.to_string();
                let _ = rt.block_on(crate::db::tasks::record_generation(
                    &pool,
                    task_id,
                    asset_id,
                    None,
                    "Error",
                    Some(&msg),
                ));
                let _ = app.emit(
                    "export:progress",
                    &BatchProgress {
                        task_id,
                        total: 1,
                        completed: 0,
                        failed: 1,
                        last_asset_id: Some(asset_id),
                        last_output: None,
                        last_error: Some(msg),
                        done: false,
                    },
                );
            }
        }

        let _ = rt.block_on(crate::db::tasks::finish(&pool, task_id));
        cleanup_watermark_file(&state.watermark_dir, task_id);
        let _ = app.emit(
            "export:progress",
            &BatchProgress {
                task_id,
                total: 1,
                completed: if result.is_ok() { 1 } else { 0 },
                failed: if result.is_err() { 1 } else { 0 },
                last_asset_id: None,
                last_output: None,
                last_error: None,
                done: true,
            },
        );

        state.task_queue.on_task_finish(task_id);
        rt.spawn(async move {
            dispatch_pending(state, app).await;
        });
    });
}

/// 把前端传来的水印层 base64 解码后写到 `<watermark_dir>/<task_id>.png`。
/// 返回写入的文件路径；无水印层时返回 None。
fn save_watermark_layer(
    layer: Option<&export::WatermarkLayer>,
    watermark_dir: &Path,
    task_id: i64,
) -> Result<Option<PathBuf>> {
    let layer = match layer {
        Some(l) => l,
        None => return Ok(None),
    };
    use base64::{engine::general_purpose, Engine as _};
    let bytes = general_purpose::STANDARD
        .decode(&layer.data)
        .map_err(|e| AppError::other(format!("watermark base64 decode: {e}")))?;
    let path = watermark_dir.join(format!("{task_id}.png"));
    std::fs::write(&path, &bytes)?;
    Ok(Some(path))
}

/// 删除水印文件（任务软删除时清理），文件不存在时静默忽略。
fn cleanup_watermark_file(watermark_dir: &Path, task_id: i64) {
    let path = watermark_dir.join(format!("{task_id}.png"));
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
}

#[tauri::command]
pub async fn get_task(state: State<'_, SharedState>, id: i64) -> Result<Option<tasks::BatchTask>> {
    tasks::get(&state.pool, id).await
}

#[tauri::command]
pub async fn list_active_tasks_on_startup(
    state: State<'_, SharedState>,
) -> Result<Vec<tasks::BatchTask>> {
    tasks::list_active_on_startup(&state.pool).await
}

/// 重试已取消/失败的任务：复用原 task_id，重置进度后重新入队调度。
#[tauri::command]
pub async fn retry_export_task(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    task_id: i64,
    watermark_layer: Option<export::WatermarkLayer>,
) -> Result<()> {
    state.task_queue.uncancel(task_id);
    tasks::reset_for_retry(&state.pool, task_id).await?;

    let task = tasks::get(&state.pool, task_id)
        .await?
        .ok_or_else(|| AppError::other("task not found"))?;
    let asset_id = task.asset_id;
    let filter: FilterSettings = serde_json::from_str(&task.filter_settings_json)?;
    let export_settings: ExportSettings = serde_json::from_str(&task.export_settings_json)?;

    let resolved_path: Option<PathBuf> = if let Some(layer) = watermark_layer {
        save_watermark_layer(Some(&layer), &state.watermark_dir, task_id)?
    } else {
        task.watermark_layer_path.as_deref().map(PathBuf::from)
    };

    let _ = app.emit(
        "export:progress",
        &BatchProgress {
            task_id,
            total: 1,
            completed: 0,
            failed: 0,
            last_asset_id: None,
            last_output: None,
            last_error: None,
            done: false,
        },
    );

    if state.task_queue.try_acquire() {
        sqlx::query("UPDATE batch_tasks SET status = 'processing' WHERE id = ?")
            .bind(task_id)
            .execute(&state.pool)
            .await?;

        let lut = super::cached_lut(&state, filter.lut_file_path.as_deref())?;
        // try_acquire 已经递增了计数器，无需再调用 on_task_start
        run_export_task(
            state.inner().clone(),
            app,
            task_id,
            asset_id,
            filter,
            export_settings,
            lut,
            resolved_path,
        );
    }

    Ok(())
}

/// 取消一个导出任务：标记取消信号（rayon 工作线程会跳过后续资产），
/// 并在数据库里标记为 cancelled（不软删除，UI 仍可见）。
#[tauri::command]
pub async fn cancel_export_task(state: State<'_, SharedState>, task_id: i64) -> Result<()> {
    state.task_queue.cancel(task_id);
    tasks::mark_cancelled(&state.pool, task_id).await
}

/// 软删除单个任务（从列表中永久移除，不影响 status），同时清理水印文件。
#[tauri::command]
pub async fn delete_export_task(state: State<'_, SharedState>, task_id: i64) -> Result<()> {
    cleanup_watermark_file(&state.watermark_dir, task_id);
    tasks::soft_delete(&state.pool, task_id).await
}

/// 批量取消 pending/processing 并软删除指定任务列表（一键清空）。
#[tauri::command]
pub async fn delete_all_export_tasks(
    state: State<'_, SharedState>,
    task_ids: Vec<i64>,
) -> Result<()> {
    for &id in &task_ids {
        state.task_queue.cancel(id);
        cleanup_watermark_file(&state.watermark_dir, id);
    }
    tasks::cancel_and_delete_batch(&state.pool, &task_ids).await
}

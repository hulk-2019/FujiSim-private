//! Tauri IPC 命令层。这里的每个 `#[tauri::command]` 都暴露给前端 JS 一一对应调用。
//!
//! 约定：
//! - 函数签名第一个参数是 `State<'_, SharedState>`，用于注入共享状态；
//! - 返回 `Result<T, AppError>`，错误会被序列化为字符串传回 JS 端的 `catch`；
//! - 长任务（导入、批量导出、预览渲染）一律放到 `tokio::task::spawn_blocking` 或
//!   `rayon` 里，不阻塞 Tauri 主事件循环。
//!
//! 命名上和前端 `src/api.ts` 中的方法名严格对齐（snake_case ↔ camelCase 由 Tauri 自动转换）。

use crate::asset::{fileops, scanner};
use crate::db::{albums, assets, presets, tasks, user_fonts, user_luts, watermark_presets};
use crate::error::{AppError, Result};
use crate::export::{self, ExportSettings};
use crate::processing::lut::Lut3D;
use crate::processing::{self, FilterSettings};
use crate::state::SharedState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, State};

/// 从 `state.lut_cache` 取出指定路径的 LUT；不存在时加载并缓存。
///
/// 解析失败会向上传播错误。空路径直接返回 `Ok(None)`，调用方据此跳过 LUT 步骤。
fn cached_lut(state: &SharedState, path: Option<&Path>) -> Result<Option<Arc<Lut3D>>> {
    let path = match path {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => return Ok(None),
    };
    let key = path.to_path_buf();
    {
        let cache = state.lut_cache.lock().expect("lut_cache poisoned");
        if let Some(lut) = cache.get(&key) {
            return Ok(Some(lut.clone()));
        }
    }
    let lut = Arc::new(Lut3D::load_cube(path)?);
    let mut cache = state.lut_cache.lock().expect("lut_cache poisoned");
    Ok(Some(cache.entry(key).or_insert(lut).clone()))
}

/// 一次目录导入的统计回执。
#[derive(Debug, Serialize, Clone)]
pub struct ImportReport {
    /// 实际写入数据库的新资产数（去重后）
    pub inserted: usize,
    /// 扫到的支持格式文件数
    pub scanned: usize,
    /// 扫描时跳过的不支持文件数
    pub skipped: usize,
}

/// 导入指定目录下所有支持的图片到资产库。
///
/// 全程后台执行：扫描走 `spawn_blocking`（阻塞 IO），数据库写入走 sqlx 异步。
/// 进度通过 Tauri Events 推送，UI 不会被卡住。
///
/// 当 `album_id` 不为 None 时，会把**本次扫到的所有路径**（不论是新增还是已存在）
/// 一并挂到该相册——这样用户在某个相册视图下点"导入目录"，新导入的资产会立刻
/// 出现在当前相册里，而不是只能在"全部资产"中找到。
#[tauri::command]
pub async fn import_directory(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    path: String,
    album_id: Option<i64>,
) -> Result<ImportReport> {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err(AppError::other("not a directory"));
    }
    let _ = app.emit("import:start", &path.display().to_string());
    let scan = tokio::task::spawn_blocking(move || scanner::scan_dir(&path))
        .await
        .map_err(|e| AppError::other(e.to_string()))??;
    let scanned = scan.items.len();
    let inserted = assets::insert_many(&state.pool, &scan.items).await?;

    if let Some(album_id) = album_id {
        let paths: Vec<String> = scan.items.iter().map(|a| a.file_path.clone()).collect();
        let ids = assets::ids_by_paths(&state.pool, &paths).await?;
        if !ids.is_empty() {
            albums::add_assets(&state.pool, album_id, &ids).await?;
        }
    }

    let report = ImportReport {
        inserted,
        scanned,
        skipped: scan.skipped,
    };
    let _ = app.emit("import:done", &report);
    start_exif_worker(state.inner().clone(), app);
    Ok(report)
}

#[tauri::command]
pub async fn list_assets(
    state: State<'_, SharedState>,
    query: assets::AssetQuery,
) -> Result<assets::ListAssetsResult> {
    assets::list(&state.pool, &query).await
}

#[tauri::command]
pub async fn get_asset(state: State<'_, SharedState>, id: i64) -> Result<assets::Asset> {
    assets::get(&state.pool, id).await
}

#[tauri::command]
pub async fn library_stats(state: State<'_, SharedState>) -> Result<assets::LibraryStats> {
    assets::stats(&state.pool).await
}

#[tauri::command]
pub async fn distinct_cameras(state: State<'_, SharedState>) -> Result<Vec<String>> {
    assets::distinct_cameras(&state.pool).await
}

#[tauri::command]
pub async fn distinct_lenses(state: State<'_, SharedState>) -> Result<Vec<String>> {
    assets::distinct_lenses(&state.pool).await
}

#[tauri::command]
pub async fn set_rating(state: State<'_, SharedState>, id: i64, rating: i64) -> Result<()> {
    assets::update_rating(&state.pool, id, rating).await
}

#[tauri::command]
pub async fn set_color_label(
    state: State<'_, SharedState>,
    id: i64,
    label: Option<String>,
) -> Result<()> {
    assets::update_color_label(&state.pool, id, label.as_deref()).await
}

#[tauri::command]
pub async fn delete_assets(
    state: State<'_, SharedState>,
    ids: Vec<i64>,
    move_to_trash: bool,
) -> Result<()> {
    for id in &ids {
        if move_to_trash {
            let asset = assets::get(&state.pool, *id).await?;
            let path = PathBuf::from(&asset.file_path);
            if path.exists() {
                fileops::move_to_trash(&path)?;
            }
        }
        assets::delete(&state.pool, *id).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn rename_asset(
    state: State<'_, SharedState>,
    id: i64,
    new_name: String,
) -> Result<assets::Asset> {
    let asset = assets::get(&state.pool, id).await?;
    if new_name.trim().is_empty() || new_name == asset.file_name {
        return Ok(asset);
    }
    let new_path = fileops::rename_file(Path::new(&asset.file_path), &new_name)?;
    let new_path_str = new_path.to_string_lossy().to_string();
    assets::update_path(&state.pool, id, &new_path_str, &new_name).await?;
    assets::get(&state.pool, id).await
}

#[tauri::command]
pub async fn rename_assets(
    state: State<'_, SharedState>,
    ids: Vec<i64>,
    template: String,
) -> Result<Vec<assets::Asset>> {
    let mut out = Vec::new();
    for (idx, id) in ids.iter().enumerate() {
        let asset = assets::get(&state.pool, *id).await?;
        let new_name = fileops::rename_with_template(
            &template,
            &asset.file_name,
            asset.date_taken.as_deref(),
            asset.camera_model.as_deref(),
            idx + 1,
        );
        if new_name == asset.file_name {
            out.push(asset);
            continue;
        }
        let new_path = fileops::rename_file(Path::new(&asset.file_path), &new_name)?;
        let new_path_str = new_path.to_string_lossy().to_string();
        assets::update_path(&state.pool, *id, &new_path_str, &new_name).await?;
        out.push(assets::get(&state.pool, *id).await?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn move_assets(
    state: State<'_, SharedState>,
    ids: Vec<i64>,
    target_dir: String,
) -> Result<Vec<assets::Asset>> {
    let target = PathBuf::from(target_dir);
    let mut out = Vec::new();
    for id in ids {
        let asset = assets::get(&state.pool, id).await?;
        let old = PathBuf::from(&asset.file_path);
        let new_path = fileops::move_file(&old, &target)?;
        let new_name = new_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&asset.file_name)
            .to_string();
        let new_path_str = new_path.to_string_lossy().to_string();
        assets::update_path(&state.pool, id, &new_path_str, &new_name).await?;
        out.push(assets::get(&state.pool, id).await?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_albums(state: State<'_, SharedState>) -> Result<Vec<albums::Album>> {
    albums::list(&state.pool).await
}

#[tauri::command]
pub async fn create_album(state: State<'_, SharedState>, name: String) -> Result<albums::Album> {
    albums::create(&state.pool, &name).await
}

#[tauri::command]
pub async fn delete_album(state: State<'_, SharedState>, id: i64) -> Result<()> {
    albums::delete(&state.pool, id).await
}

#[tauri::command]
pub async fn check_album_name_exists(
    state: State<'_, SharedState>,
    name: String,
    exclude_id: Option<i64>,
) -> Result<bool> {
    albums::name_exists(&state.pool, &name, exclude_id).await
}

#[tauri::command]
pub async fn rename_album(
    state: State<'_, SharedState>,
    id: i64,
    name: String,
) -> Result<albums::Album> {
    albums::rename(&state.pool, id, &name).await
}

#[tauri::command]
pub async fn get_folder_asset_count(
    state: State<'_, SharedState>,
    id: i64,
) -> Result<i64> {
    albums::asset_count(&state.pool, id).await
}

#[tauri::command]
pub async fn delete_folder(
    state: State<'_, SharedState>,
    id: i64,
) -> Result<()> {
    let paths = albums::delete_with_assets(&state.pool, id).await?;
    for p in paths {
        let path = std::path::PathBuf::from(&p);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn album_add(
    state: State<'_, SharedState>,
    album_id: i64,
    asset_ids: Vec<i64>,
) -> Result<()> {
    albums::add_assets(&state.pool, album_id, &asset_ids).await
}

#[tauri::command]
pub async fn album_remove(
    state: State<'_, SharedState>,
    album_id: i64,
    asset_ids: Vec<i64>,
) -> Result<()> {
    albums::remove_assets(&state.pool, album_id, &asset_ids).await
}

#[tauri::command]
pub async fn list_presets(state: State<'_, SharedState>) -> Result<Vec<presets::FilterPreset>> {
    presets::list(&state.pool).await
}

#[tauri::command]
pub async fn save_preset(
    state: State<'_, SharedState>,
    preset: presets::NewFilterPreset,
) -> Result<presets::FilterPreset> {
    presets::upsert(&state.pool, &preset).await
}

#[tauri::command]
pub async fn delete_preset(state: State<'_, SharedState>, id: i64) -> Result<()> {
    presets::delete(&state.pool, id).await
}

/// 预览结果。前端用 convertFileSrc(path) 加载本地文件，零 IPC 传输开销。
#[derive(Debug, Serialize, Clone)]
pub struct PreviewResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// 渲染单张照片的预览图。
///
/// 关键优化：先下采样到 `max_edge`（默认 1280px）再走色彩流水线，
/// 把一张 6000×4000 像素图的处理压缩到 1280×853，速度提升约 20×，
/// 视觉效果对 UI 预览足够。
/// 使用独立的 preview_pool，与导出任务的 export_pool 隔离，避免导出阻塞预览响应。
/// 下采样结果缓存在 state.preview_cache，调整滤镜时命中缓存可跳过磁盘 IO 和 RAW 解码。
#[tauri::command]
pub async fn get_preview(
    state: State<'_, SharedState>,
    asset_id: i64,
    settings: Option<FilterSettings>,
    max_edge: Option<u32>,
) -> Result<PreviewResult> {
    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);
    let max_edge = max_edge.unwrap_or(1280);
    let settings = settings.unwrap_or_default();
    let lut = cached_lut(&state, settings.lut_file_path.as_deref())?;
    let preview_pool = state.preview_pool.clone();
    let preview_cache_dir = state.preview_cache_dir.clone();

    // 尝试从缓存取下采样底图，命中时跳过磁盘 IO + RAW 解码
    let cached = state
        .preview_cache
        .lock()
        .ok()
        .and_then(|c| c.get(&(asset_id, max_edge)).cloned());

    if let Some(resized) = cached {
        let pcd = preview_cache_dir.clone();
        return tokio::task::spawn_blocking(move || {
            preview_pool.install(|| render_preview_from_cache(&resized, &settings, lut.as_deref(), &pcd, asset_id))
        })
        .await
        .map_err(|e| AppError::other(e.to_string()))?;
    }

    // 未命中：在 async 上下文 acquire permit，排队等待而非降级，
    // 保证同时进入 load_and_downsample 的请求严格 ≤ 2。
    let cache = state.preview_cache.clone();
    let permit = state.preview_sem.clone().acquire_owned().await
        .map_err(|e| AppError::other(e.to_string()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit; // 持有至 blocking 任务结束
        preview_pool.install(|| {
            let resized = load_and_downsample(&path, max_edge)?;
            let resized = Arc::new(resized);

            if let Ok(mut c) = cache.lock() {
                while c.len() >= 20 {
                    c.shift_remove_index(0);
                }
                c.insert((asset_id, max_edge), resized.clone());
            }

            render_preview_from_cache(&resized, &settings, lut.as_deref(), &preview_cache_dir, asset_id)
        })
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}

/// 从磁盘加载图片并下采样到 `max_edge`，返回 16-bit RGB 缓冲区。
/// 结果会被缓存在 preview_cache，调整滤镜时无需重复执行。
fn load_and_downsample(path: &Path, max_edge: u32) -> Result<image::ImageBuffer<image::Rgb<u16>, Vec<u16>>> {
    use crate::asset::format::{classify, FileKind};
    let src = match classify(path) {
        FileKind::Raw => processing::raw::decode_raw_rgb16_for_preview(path, max_edge)?,
        _ => processing::load_image_rgb16(path)?,
    };
    let (w, h) = src.dimensions();
    let scale = (max_edge as f32 / w.max(h) as f32).min(1.0);
    if scale < 1.0 {
        let nw = (w as f32 * scale).round().max(1.0) as u32;
        let nh = (h as f32 * scale).round().max(1.0) as u32;
        Ok(image::imageops::resize(&src, nw, nh, image::imageops::FilterType::Triangle))
    } else {
        Ok(src)
    }
}

/// 从已下采样的底图应用色彩流水线，将结果写入 preview_cache_dir 下的 JPEG 文件，
/// 返回文件路径供前端用 convertFileSrc 加载。相同参数命中磁盘缓存时直接返回路径。
fn render_preview_from_cache(
    resized: &image::ImageBuffer<image::Rgb<u16>, Vec<u16>>,
    settings: &FilterSettings,
    lut: Option<&Lut3D>,
    preview_cache_dir: &std::path::Path,
    asset_id: i64,
) -> Result<PreviewResult> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    settings.base_simulation.hash(&mut hasher);
    settings.grain_effect.hash(&mut hasher);
    settings.highlight_tone.to_bits().hash(&mut hasher);
    settings.shadow_tone.to_bits().hash(&mut hasher);
    settings.color_saturation.to_bits().hash(&mut hasher);
    settings.clarity.to_bits().hash(&mut hasher);
    settings.sharpness.to_bits().hash(&mut hasher);
    settings.wb_shift_r.hash(&mut hasher);
    settings.wb_shift_b.hash(&mut hasher);
    settings.lut_file_path.hash(&mut hasher);
    let h = hasher.finish();

    let file_name = format!("{}_{:016x}.jpg", asset_id, h);
    let out_path = preview_cache_dir.join(&file_name);

    if !out_path.exists() {
        let processed = crate::processing::process_image(resized, settings, lut)?;
        let (pw, ph) = processed.dimensions();
        let mut rgb8 = image::RgbImage::new(pw, ph);
        for (x, y, px) in processed.enumerate_pixels() {
            rgb8.put_pixel(x, y, image::Rgb([
                (px.0[0] >> 8) as u8,
                (px.0[1] >> 8) as u8,
                (px.0[2] >> 8) as u8,
            ]));
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 88);
        rgb8.write_with_encoder(encoder)
            .map_err(|e| crate::error::AppError::other(format!("jpeg encode: {e}")))?;
        std::fs::write(&out_path, buf.into_inner())
            .map_err(|e| crate::error::AppError::other(format!("preview write: {e}")))?;

        evict_preview_cache(preview_cache_dir, 40);
    }

    let (w, h_px) = resized.dimensions();
    Ok(PreviewResult {
        path: out_path.to_string_lossy().to_string(),
        width: w,
        height: h_px,
    })
}

fn evict_preview_cache(dir: &std::path::Path, max_files: usize) {
    let Ok(mut entries) = std::fs::read_dir(dir).map(|rd| {
        rd.filter_map(|e| e.ok())
          .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jpg"))
          .collect::<Vec<_>>()
    }) else { return };
    if entries.len() <= max_files { return }
    entries.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    for e in entries.iter().take(entries.len() - max_files) {
        let _ = std::fs::remove_file(e.path());
    }
}

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
        let watermark_layer = request.per_asset_watermark.as_ref()
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
        let _ = app.emit("export:progress", &BatchProgress {
            task_id,
            total: 1,
            completed: 0,
            failed: 0,
            last_asset_id: None,
            last_output: None,
            last_error: None,
            done: false,
        });
    }

    // 立即填满队列空位
    dispatch_pending(state.inner().clone(), app).await;

    Ok(task_ids)
}

/// 从数据库取出 pending 任务填充空闲并发槽位。
async fn dispatch_pending(state: SharedState, app: tauri::AppHandle) {
    while state.task_queue.can_start_more() {
        let task = match tasks::claim_next_pending(&state.pool).await {
            Ok(Some(t)) => t,
            _ => break,
        };

        let task_id = task.id;
        let asset_id = task.asset_id;
        let filter: FilterSettings = match serde_json::from_str(&task.filter_settings_json) {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(task_id, error = %e, "dispatch_pending: bad filter_json");
                let _ = tasks::finish(&state.pool, task_id).await;
                continue;
            }
        };
        let export_settings: ExportSettings = match serde_json::from_str(&task.export_settings_json) {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(task_id, error = %e, "dispatch_pending: bad export_json");
                let _ = tasks::finish(&state.pool, task_id).await;
                continue;
            }
        };
        let lut = match cached_lut(&state, filter.lut_file_path.as_deref()) {
            Ok(l) => l,
            Err(e) => {
                tracing::error!(task_id, error = %e, "dispatch_pending: lut load failed");
                let _ = tasks::finish(&state.pool, task_id).await;
                continue;
            }
        };
        let watermark_path: Option<PathBuf> = task
            .watermark_layer_path
            .as_deref()
            .map(PathBuf::from);

        state.task_queue.on_task_start();
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

        let _ = app.emit("export:progress", &BatchProgress {
            task_id, total: 1,
            completed: 0, failed: 0,
            last_asset_id: None, last_output: None, last_error: None,
            done: false,
        });

        if state.task_queue.is_cancelled(task_id) {
            let _ = rt.block_on(crate::db::tasks::finish(&pool, task_id));
            state.task_queue.on_task_finish(task_id);
            rt.spawn(async move { dispatch_pending(state, app).await; });
            return;
        }

        let asset = match rt.block_on(crate::db::assets::get(&pool, asset_id)) {
            Ok(a) => a,
            Err(e) => {
                tracing::error!(task_id, asset_id, error = %e, "run_export_task: asset not found");
                let _ = rt.block_on(crate::db::tasks::finish(&pool, task_id));
                cleanup_watermark_file(&state.watermark_dir, task_id);
                state.task_queue.on_task_finish(task_id);
                rt.spawn(async move { dispatch_pending(state, app).await; });
                return;
            }
        };

        let needed_mb = estimate_export_memory_mb(asset.file_size.unwrap_or(30 * 1024 * 1024));

        // 等待内存预算（最多 30s），CAS 扣减
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let current = state.export_memory_budget.load(std::sync::atomic::Ordering::SeqCst);
            if current >= needed_mb {
                if state.export_memory_budget
                    .compare_exchange(current, current - needed_mb,
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst)
                    .is_ok()
                {
                    break;
                }
            }
            if std::time::Instant::now() > deadline { break; }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }

        let src_path = std::path::PathBuf::from(&asset.file_path);

        // 在 export_pool 内执行，确保 process_image 的 rayon 并行使用受控线程池
        // 而非全局线程池，避免导出任务占满所有 CPU 核心
        let result: Result<PathBuf> = state.export_pool.install(|| {
            export::resolve_destination_dir(&src_path, &export_settings.destination)
                .and_then(|dest| export::export_one(
                    &src_path, &dest, &filter, &export_settings,
                    lut.as_deref(), watermark_path.as_deref(),
                ))
        });

        // 归还内存预算
        state.export_memory_budget.fetch_add(needed_mb, std::sync::atomic::Ordering::SeqCst);

        match &result {
            Ok(out) => {
                let _ = rt.block_on(crate::db::tasks::record_generation(
                    &pool, task_id, asset_id,
                    Some(out.to_string_lossy().as_ref()), "Success", None,
                ));
                let _ = app.emit("export:progress", &BatchProgress {
                    task_id, total: 1, completed: 1, failed: 0,
                    last_asset_id: Some(asset_id),
                    last_output: Some(out.to_string_lossy().to_string()),
                    last_error: None, done: false,
                });
            }
            Err(e) => {
                let msg = e.to_string();
                let _ = rt.block_on(crate::db::tasks::record_generation(
                    &pool, task_id, asset_id, None, "Error", Some(&msg),
                ));
                let _ = app.emit("export:progress", &BatchProgress {
                    task_id, total: 1, completed: 0, failed: 1,
                    last_asset_id: Some(asset_id),
                    last_output: None, last_error: Some(msg), done: false,
                });
            }
        }

        let _ = rt.block_on(crate::db::tasks::finish(&pool, task_id));
        cleanup_watermark_file(&state.watermark_dir, task_id);
        let _ = app.emit("export:progress", &BatchProgress {
            task_id, total: 1,
            completed: if result.is_ok() { 1 } else { 0 },
            failed: if result.is_err() { 1 } else { 0 },
            last_asset_id: None, last_output: None, last_error: None,
            done: true,
        });

        state.task_queue.on_task_finish(task_id);
        rt.spawn(async move { dispatch_pending(state, app).await; });
    });
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

#[tauri::command]
pub async fn list_fuji_simulations() -> Result<Vec<String>> {
    Ok(processing::fuji::BUILTIN_NAMES.iter().map(|s| s.to_string()).collect())
}

/// 导入用户手动选择的图片文件列表（不递归）。
///
/// 与 `import_directory` 的区别：接受的是文件路径列表而非目录，
/// 适合用户在文件选择对话框里多选图片的场景。
/// 同样支持 `album_id`：若提供则把所有文件挂到该相册。
#[tauri::command]
pub async fn import_files(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    paths: Vec<String>,
    album_id: Option<i64>,
) -> Result<ImportReport> {
    let path_bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let _ = app.emit("import:start", paths.len());
    let scan = tokio::task::spawn_blocking(move || scanner::scan_files(&path_bufs))
        .await
        .map_err(|e| AppError::other(e.to_string()))??;
    let scanned = scan.items.len();
    let inserted = assets::insert_many(&state.pool, &scan.items).await?;

    if let Some(album_id) = album_id {
        let file_paths: Vec<String> = scan.items.iter().map(|a| a.file_path.clone()).collect();
        let ids = assets::ids_by_paths(&state.pool, &file_paths).await?;
        if !ids.is_empty() {
            albums::add_assets(&state.pool, album_id, &ids).await?;
        }
    }

    let report = ImportReport {
        inserted,
        scanned,
        skipped: scan.skipped,
    };
    let _ = app.emit("import:done", &report);
    start_exif_worker(state.inner().clone(), app);
    Ok(report)
}

/// 扫描目录下所有 `.cube` 文件并批量导入到用户 LUT 库。
///
/// 复用 `import_luts` 的单文件处理逻辑（校验 + 复制 + 入库），
/// 单个文件失败不阻塞其它。
#[tauri::command]
pub async fn import_luts_from_dir(
    state: State<'_, SharedState>,
    dir: String,
) -> Result<Vec<user_luts::UserLut>> {
    let dir_path = PathBuf::from(&dir);
    if !dir_path.is_dir() {
        return Err(AppError::other("not a directory"));
    }
    let cube_paths: Vec<String> = walkdir::WalkDir::new(&dir_path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|x| x.eq_ignore_ascii_case("cube"))
                    .unwrap_or(false)
        })
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();

    // 复用已有的 import_luts 逻辑（校验 + 复制 + 入库）
    let mut out = Vec::with_capacity(cube_paths.len());
    for raw in cube_paths {
        let src = PathBuf::from(&raw);
        if let Err(e) = crate::processing::lut::Lut3D::load_cube(&src) {
            tracing::warn!(?src, error = %e, "import_luts_from_dir: invalid cube, skip");
            continue;
        }
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("lut").to_string();
        let display_name = match unique_lut_name(&state.pool, &stem).await {
            Ok(n) => n,
            Err(e) => { tracing::warn!(?src, error = %e, "import_luts_from_dir: name check failed"); continue; }
        };
        let dest = match unique_lut_dest(&state.lut_dir, &stem) {
            Ok(p) => p,
            Err(e) => { tracing::warn!(?src, error = %e, "import_luts_from_dir: pick dest failed"); continue; }
        };
        if let Err(e) = std::fs::copy(&src, &dest) {
            tracing::warn!(?src, ?dest, error = %e, "import_luts_from_dir: copy failed"); continue;
        }
        let dest_str = dest.to_string_lossy().to_string();
        match user_luts::insert(&state.pool, &display_name, &dest_str).await {
            Ok(lut) => out.push(lut),
            Err(e) => { tracing::warn!(?dest, error = %e, "import_luts_from_dir: db insert failed"); let _ = std::fs::remove_file(&dest); }
        }
    }
    Ok(out)
}
///
/// 对每个路径：先用 [`Lut3D::load_cube`] 校验合法，再把文件**复制**到应用数据目录
/// `<data_dir>/luts/` 下，最后落库 `user_luts`。文件名或显示名冲突时会自动追加
/// `-{n}` 后缀（互不影响）。
///
/// 单个文件失败不中断整批：用 tracing 记录错误并跳过，最终只返回成功入库的条目。
#[tauri::command]
pub async fn import_luts(
    state: State<'_, SharedState>,
    paths: Vec<String>,
) -> Result<Vec<user_luts::UserLut>> {
    let mut out = Vec::with_capacity(paths.len());
    for raw in paths {
        let src = PathBuf::from(&raw);
        if !src.is_file() {
            tracing::warn!(?src, "import_luts: skip non-file path");
            continue;
        }
        // 校验 .cube 合法（解析失败直接跳过，避免污染 LUT 库）
        if let Err(e) = Lut3D::load_cube(&src) {
            tracing::warn!(?src, error = %e, "import_luts: invalid cube, skip");
            continue;
        }

        let stem = src
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("lut")
            .to_string();
        let display_name = match unique_lut_name(&state.pool, &stem).await {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(?src, error = %e, "import_luts: name uniqueness check failed");
                continue;
            }
        };

        let dest = match unique_lut_dest(&state.lut_dir, &stem) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(?src, error = %e, "import_luts: pick dest failed");
                continue;
            }
        };
        if let Err(e) = std::fs::copy(&src, &dest) {
            tracing::warn!(?src, ?dest, error = %e, "import_luts: copy failed");
            continue;
        }

        let dest_str = dest.to_string_lossy().to_string();
        match user_luts::insert(&state.pool, &display_name, &dest_str).await {
            Ok(lut) => out.push(lut),
            Err(e) => {
                tracing::warn!(?dest, error = %e, "import_luts: db insert failed");
                let _ = std::fs::remove_file(&dest);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_user_luts(state: State<'_, SharedState>) -> Result<Vec<user_luts::UserLut>> {
    user_luts::list(&state.pool).await
}

#[tauri::command]
pub async fn delete_user_lut(state: State<'_, SharedState>, id: i64) -> Result<()> {
    if let Some(path) = user_luts::delete(&state.pool, id).await? {
        let p = PathBuf::from(&path);
        // 同步把内存里缓存的 Lut3D 也清掉，避免被释放的 LUT 仍占着堆
        if let Ok(mut cache) = state.lut_cache.lock() {
            cache.remove(&p);
        }
        // 容忍文件已经手动删除：只有"非 NotFound" 的 IO 错误才向上抛
        if let Err(e) = std::fs::remove_file(&p) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e.into());
            }
        }
    }
    Ok(())
}

/// 在 LUT 库中给新 LUT 选一个不冲突的显示名。
async fn unique_lut_name(pool: &sqlx::SqlitePool, stem: &str) -> Result<String> {
    if !user_luts::name_exists(pool, stem).await? {
        return Ok(stem.to_string());
    }
    for i in 2..1000 {
        let cand = format!("{stem}-{i}");
        if !user_luts::name_exists(pool, &cand).await? {
            return Ok(cand);
        }
    }
    Err(AppError::other("too many luts with the same name"))
}

/// 在 lut_dir 下给新 LUT 选一个不冲突的物理文件路径。
fn unique_lut_dest(dir: &Path, stem: &str) -> Result<PathBuf> {
    let primary = dir.join(format!("{stem}.cube"));
    if !primary.exists() {
        return Ok(primary);
    }
    for i in 2..1000 {
        let cand = dir.join(format!("{stem}-{i}.cube"));
        if !cand.exists() {
            return Ok(cand);
        }
    }
    Err(AppError::other("too many lut files with the same name"))
}

/// 清除所有应用数据（数据库 + LUT 副本 + 缩略图缓存），并清空内存 LUT 缓存。
///
/// 用途：
/// 1. 用户在设置里主动"重置应用"；
/// 2. 卸载前手动调用，确保不留残留文件。
///
/// 注意：此操作不可逆，调用方（前端）应在执行前弹出二次确认对话框。
/// 操作完成后应用需要重启才能正常使用（连接池已关闭）。
#[tauri::command]
pub async fn reset_app_data(state: State<'_, SharedState>) -> Result<()> {
    // 先清内存缓存，避免后续操作触发 LUT 重新加载
    if let Ok(mut cache) = state.lut_cache.lock() {
        cache.clear();
    }
    // 关闭连接池，确保 SQLite 文件句柄释放（WAL 文件也会随之关闭）
    state.pool.close().await;
    // 删除整个数据目录（包含 library.db / library.db-wal / library.db-shm / luts/ / thumbnails/）
    if state.data_dir.exists() {
        std::fs::remove_dir_all(&state.data_dir)?;
    }
    Ok(())
}

/// 懒加载 RAW 预览图：优先读磁盘缓存，命中时直接返回路径。
/// 未命中时提取嵌入 JPEG（含 orientation 校正）写盘，返回路径。
/// 前端用 convertFileSrc(path) 加载，无 base64 开销。
#[tauri::command]
pub async fn get_raw_thumbnail(
    state: State<'_, SharedState>,
    asset_id: i64,
) -> Result<String> {
    let asset = assets::get(&state.pool, asset_id).await?;
    let mtime = std::path::Path::new(&asset.file_path)
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cache_path = state.thumbnail_dir.join(format!("{asset_id}_{mtime}.jpg"));

    // 磁盘缓存命中：直接返回
    if cache_path.exists() {
        return Ok(cache_path.to_string_lossy().to_string());
    }

    let file_path = std::path::PathBuf::from(&asset.file_path);
    let sem = state.io_sem.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = sem.try_acquire_owned().ok();
        let bytes = processing::raw::extract_raw_thumbnail(&file_path)?;
        std::fs::write(&cache_path, &bytes)
            .map_err(|e| AppError::other(format!("thumbnail write: {e}")))?;
        Ok(cache_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}

/// 返回所有 RAW 资产的 id 列表，供前端触发全量缩略图生成（不受分页限制）。
#[tauri::command]
pub async fn list_raw_asset_ids(state: State<'_, SharedState>) -> Result<Vec<i64>> {
    assets::all_raw_ids(&state.pool).await
}

#[tauri::command]
pub async fn list_watermark_presets(
    state: State<'_, SharedState>,
) -> Result<Vec<watermark_presets::WatermarkPreset>> {
    watermark_presets::list(&state.pool).await
}

#[tauri::command]
pub async fn create_watermark_preset(
    state: State<'_, SharedState>,
    name: String,
    settings_json: String,
) -> Result<watermark_presets::WatermarkPreset> {
    watermark_presets::create(&state.pool, &name, &settings_json).await
}

#[tauri::command]
pub async fn update_watermark_preset(
    state: State<'_, SharedState>,
    id: i64,
    name: String,
    settings_json: String,
) -> Result<watermark_presets::WatermarkPreset> {
    watermark_presets::update(&state.pool, id, &name, &settings_json).await
}

#[tauri::command]
pub async fn delete_watermark_preset(state: State<'_, SharedState>, id: i64) -> Result<()> {
    watermark_presets::delete(&state.pool, id).await
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

    let task = tasks::get(&state.pool, task_id).await?
        .ok_or_else(|| AppError::other("task not found"))?;
    let asset_id = task.asset_id;
    let filter: FilterSettings = serde_json::from_str(&task.filter_settings_json)?;
    let export_settings: ExportSettings = serde_json::from_str(&task.export_settings_json)?;

    let resolved_path: Option<PathBuf> = if let Some(layer) = watermark_layer {
        save_watermark_layer(Some(&layer), &state.watermark_dir, task_id)?
    } else {
        task.watermark_layer_path.as_deref().map(PathBuf::from)
    };

    let _ = app.emit("export:progress", &BatchProgress {
        task_id, total: 1,
        completed: 0, failed: 0,
        last_asset_id: None, last_output: None, last_error: None,
        done: false,
    });

    if state.task_queue.can_start_more() {
        sqlx::query("UPDATE batch_tasks SET status = 'processing' WHERE id = ?")
            .bind(task_id)
            .execute(&state.pool)
            .await?;

        let lut = cached_lut(&state, filter.lut_file_path.as_deref())?;
        state.task_queue.on_task_start();
        run_export_task(
            state.inner().clone(), app,
            task_id, asset_id, filter, export_settings, lut, resolved_path,
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

/// 清空所有业务表数据（保留表结构）。用于"清除缓存"功能。
/// 同时清空内存中的 LUT 缓存。
#[tauri::command]
pub async fn clear_all_data(state: State<'_, SharedState>) -> Result<()> {
    tasks::clear_all(&state.pool).await?;
    if let Ok(mut cache) = state.lut_cache.lock() {
        cache.clear();
    }
    if let Ok(mut cache) = state.preview_cache.lock() {
        cache.clear();
    }
    // watermarks 目录整体清空
    if state.watermark_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.watermark_dir);
        let _ = std::fs::create_dir_all(&state.watermark_dir);
    }
    // thumbnails 目录整体清空
    if state.thumbnail_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.thumbnail_dir);
        let _ = std::fs::create_dir_all(&state.thumbnail_dir);
    }
    // covers 目录整体清空
    if state.cover_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.cover_dir);
        let _ = std::fs::create_dir_all(&state.cover_dir);
    }
    // preview_cache 目录整体清空
    if state.preview_cache_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.preview_cache_dir);
        let _ = std::fs::create_dir_all(&state.preview_cache_dir);
    }
    // 软删除所有字体记录，清空 fonts 目录
    user_fonts::delete_all(&state.pool).await?;
    if state.font_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.font_dir);
        let _ = std::fs::create_dir_all(&state.font_dir);
    }
    Ok(())
}

const ALLOWED_FONT_EXTS: &[&str] = &["ttf", "otf", "woff", "woff2"];

async fn unique_font_name(pool: &sqlx::SqlitePool, stem: &str) -> Result<String> {
    if !user_fonts::name_exists(pool, stem).await? {
        return Ok(stem.to_string());
    }
    for i in 2..1000 {
        let cand = format!("{stem}-{i}");
        if !user_fonts::name_exists(pool, &cand).await? {
            return Ok(cand);
        }
    }
    Err(AppError::other("too many fonts with the same name"))
}

fn unique_font_dest(dir: &Path, stem: &str, ext: &str) -> Result<PathBuf> {
    let primary = dir.join(format!("{stem}.{ext}"));
    if !primary.exists() {
        return Ok(primary);
    }
    for i in 2..1000 {
        let cand = dir.join(format!("{stem}-{i}.{ext}"));
        if !cand.exists() {
            return Ok(cand);
        }
    }
    Err(AppError::other("too many font files with the same name"))
}

#[tauri::command]
pub async fn import_fonts(
    state: State<'_, SharedState>,
    paths: Vec<String>,
) -> Result<Vec<user_fonts::UserFont>> {
    let mut out = Vec::with_capacity(paths.len());
    for raw in paths {
        let src = PathBuf::from(&raw);
        if !src.is_file() {
            tracing::warn!(?src, "import_fonts: skip non-file path");
            continue;
        }
        let ext = match src.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()) {
            Some(e) if ALLOWED_FONT_EXTS.contains(&e.as_str()) => e,
            _ => {
                tracing::warn!(?src, "import_fonts: unsupported extension, skip");
                continue;
            }
        };
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("font").to_string();
        let display_name = match unique_font_name(&state.pool, &stem).await {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(?src, error = %e, "import_fonts: name uniqueness check failed");
                continue;
            }
        };
        let dest = match unique_font_dest(&state.font_dir, &stem, &ext) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(?src, error = %e, "import_fonts: pick dest failed");
                continue;
            }
        };
        if let Err(e) = std::fs::copy(&src, &dest) {
            tracing::warn!(?src, ?dest, error = %e, "import_fonts: copy failed");
            continue;
        }
        let dest_str = dest.to_string_lossy().to_string();
        match user_fonts::insert(&state.pool, &display_name, &dest_str, &ext).await {
            Ok(font) => out.push(font),
            Err(e) => {
                tracing::warn!(?dest, error = %e, "import_fonts: db insert failed");
                let _ = std::fs::remove_file(&dest);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_user_fonts(state: State<'_, SharedState>) -> Result<Vec<user_fonts::UserFont>> {
    user_fonts::list(&state.pool).await
}

#[tauri::command]
pub async fn delete_user_font(state: State<'_, SharedState>, id: i64) -> Result<()> {
    if let Some(path) = user_fonts::delete(&state.pool, id).await? {
        let p = PathBuf::from(&path);
        if let Err(e) = std::fs::remove_file(&p) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e.into());
            }
        }
    }
    Ok(())
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

/// 后台 EXIF 提取 worker：循环取出 exif_extracted=0 的资产，
/// 通过 io_sem（共享，permits=4）串行控制并发，每次 acquire 后 await 完成再继续，
/// 保证同时运行的 blocking 线程数不超过 4。
fn start_exif_worker(state: SharedState, app: tauri::AppHandle) {
    tokio::task::spawn(async move {
        loop {
            let batch = match crate::db::assets::list_exif_pending(&state.pool, 20).await {
                Ok(b) => b,
                Err(_) => break,
            };
            if batch.is_empty() { break; }

            for asset in batch {
                let permit = state.io_sem.clone().acquire_owned().await;
                let Ok(permit) = permit else { break };
                let pool = state.pool.clone();
                let app2 = app.clone();
                // await 每个任务完成后再 acquire 下一个 permit，真正串行限流
                let _ = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    let path = std::path::Path::new(&asset.file_path);
                    let kind = crate::asset::format::classify(path);
                    let (exif, width, height) = crate::asset::scanner::extract_exif_only(path, kind);
                    let rt = tokio::runtime::Handle::current();
                    let _ = rt.block_on(crate::db::assets::update_exif(
                        &pool, asset.id, &exif, width, height,
                    ));
                    let _ = app2.emit("exif:item_done", asset.id);
                }).await;
            }
            let _ = app.emit("exif:batch_done", ());
        }
    });
}

/// `thumbnail:done` 事件载荷：单张缩略图写盘完成。
#[derive(Debug, Serialize, Clone)]
pub struct ThumbnailDonePayload {
    pub asset_id: i64,
}

/// 批量为 RAW/DNG 资产生成磁盘缩略图缓存。
///
/// 串行处理每张：已有缓存则跳过（幂等）；提取并写盘后推送 `thumbnail:done` 事件。
/// 全部处理完毕后推送 `thumbnail:all_done`（无载荷）。
/// 单张失败不中断整批，只记录 warning。
/// 通过 Semaphore 限制最大并发为 2，避免启动时大量 RAW 解码占满 CPU。
#[tauri::command]
pub async fn generate_thumbnails(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    asset_ids: Vec<i64>,
) -> Result<()> {
    let mut raw_assets = Vec::new();
    for id in &asset_ids {
        match assets::get(&state.pool, *id).await {
            Ok(a) if a.is_raw != 0 => raw_assets.push(a),
            _ => {}
        }
    }

    let cover_dir = state.cover_dir.clone();
    let sem = state.io_sem.clone();

    tokio::task::spawn(async move {
        for asset in raw_assets {
            let permit = sem.clone().acquire_owned().await;
            let Ok(permit) = permit else { break };
            let cover_dir = cover_dir.clone();
            let app = app.clone();
            // await 每个任务完成后再继续，真正串行限流，不会同时 spawn 大量 blocking 线程
            let _ = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let mtime = std::path::Path::new(&asset.file_path)
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let cover_path = cover_dir.join(format!("{}_{}.jpg", asset.id, mtime));

                // 幂等：cover 文件已存在则跳过
                if cover_path.exists() {
                    let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
                    return;
                }

                let src = std::path::PathBuf::from(&asset.file_path);
                let cover_jpeg = match processing::raw::extract_cover_fast(&src, 400) {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: cover extract failed");
                        return;
                    }
                };

                if let Err(e) = std::fs::write(&cover_path, &cover_jpeg) {
                    tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: write cover failed");
                    return;
                }

                let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
            }).await;
        }
        let _ = app.emit("thumbnail:all_done", ());
    });

    Ok(())
}

/// 返回缩略图缓存目录的绝对路径，供前端拼接 convertFileSrc 使用。
#[tauri::command]
pub async fn get_thumbnail_dir(state: State<'_, SharedState>) -> Result<String> {
    Ok(state.thumbnail_dir.to_string_lossy().to_string())
}

/// 返回封面图缓存目录的绝对路径，供前端拼接 convertFileSrc 使用。
#[tauri::command]
pub async fn get_cover_dir(state: State<'_, SharedState>) -> Result<String> {
    Ok(state.cover_dir.to_string_lossy().to_string())
}
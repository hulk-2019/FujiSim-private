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
use crate::db::{albums, assets, presets, tasks, user_luts};
use crate::error::{AppError, Result};
use crate::export::{self, ExportSettings};
use crate::processing::lut::Lut3D;
use crate::processing::{self, FilterSettings};
use crate::state::SharedState;
use base64::{engine::general_purpose, Engine as _};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
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
    Ok(report)
}

#[tauri::command]
pub async fn list_assets(
    state: State<'_, SharedState>,
    query: assets::AssetQuery,
) -> Result<Vec<assets::Asset>> {
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

/// 预览结果。前端拿到 `data:` URL 即可直接显示。
#[derive(Debug, Serialize)]
pub struct PreviewResult {
    pub mime: String,
    /// JPEG 字节的 base64 编码
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// 渲染单张照片的预览图。
///
/// 关键优化：先下采样到 `max_edge`（默认 1280px）再走色彩流水线，
/// 把一张 6000×4000 像素图的处理压缩到 1280×853，速度提升约 20×，
/// 视觉效果对 UI 预览足够。
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
    // 在阻塞任务前先把 LUT 准备好，复用 state 上的内存缓存
    let lut = cached_lut(&state, settings.lut_file_path.as_deref())?;
    tokio::task::spawn_blocking(move || render_preview(&path, &settings, max_edge, lut.as_deref()))
        .await
        .map_err(|e| AppError::other(e.to_string()))?
}

fn render_preview(
    path: &Path,
    settings: &FilterSettings,
    max_edge: u32,
    lut: Option<&Lut3D>,
) -> Result<PreviewResult> {
    // 先下采样，源图缓冲尽快释放
    let resized = {
        let src = processing::load_image_rgb16(path)?;
        let (w, h) = src.dimensions();
        let scale = (max_edge as f32 / w.max(h) as f32).min(1.0);
        if scale < 1.0 {
            let nw = (w as f32 * scale).round().max(1.0) as u32;
            let nh = (h as f32 * scale).round().max(1.0) as u32;
            image::imageops::resize(&src, nw, nh, image::imageops::FilterType::Triangle)
        } else {
            src
        }
    };

    let processed = processing::process_image(&resized, settings, lut)?;
    drop(resized);

    let (pw, ph) = (processed.width(), processed.height());
    let mut rgb8 = image::RgbImage::new(pw, ph);
    for (x, y, px) in processed.enumerate_pixels() {
        rgb8.put_pixel(
            x,
            y,
            image::Rgb([
                (px.0[0] >> 8) as u8,
                (px.0[1] >> 8) as u8,
                (px.0[2] >> 8) as u8,
            ]),
        );
    }
    drop(processed);

    let mut buf = std::io::Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 88);
    rgb8.write_with_encoder(encoder)?;
    drop(rgb8);
    let data = general_purpose::STANDARD.encode(buf.get_ref());
    Ok(PreviewResult {
        mime: "image/jpeg".into(),
        data,
        width: pw,
        height: ph,
    })
}

/// 批量导出请求体。前端把"待处理 id 列表 + 滤镜 + 导出配置"一起发过来，
/// 后端创建一个 `batch_tasks` 记录，再用 rayon 并行处理。
#[derive(Debug, Deserialize)]
pub struct BatchExportRequest {
    pub asset_ids: Vec<i64>,
    pub filter: FilterSettings,
    pub export: ExportSettings,
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
/// 返回新建的 `task_id`；真正的工作在 spawn 出去的线程里跑，
/// 单张资产的进度/错误通过 Tauri Events 推送，前端 listen 即可。
///
/// 并发模型：
/// - 内层用 `state.export_pool`（rayon 2 线程）跑文件并行处理，
///   避免默认线程池（= CPU 核心数）下大图同时进入流水线导致内存溢出；
/// - 数据库写入用 `tokio::runtime::Handle::current().block_on(...)` 桥接，
///   因为 rayon 线程不能直接 await；
/// - LUT 走 `cached_lut` 复用解析结果，整批只解析一次。
#[tauri::command]
pub async fn start_batch_export(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    request: BatchExportRequest,
) -> Result<i64> {
    let filter_json = serde_json::to_string(&request.filter)?;
    let export_json = serde_json::to_string(&request.export)?;
    let task_id =
        tasks::create(&state.pool, request.asset_ids.len() as i64, &export_json, &filter_json)
            .await?;

    // 整批共用一份 LUT，避免每张图都重新读盘/解析
    let lut = cached_lut(&state, request.filter.lut_file_path.as_deref())?;

    let state_inner: SharedState = state.inner().clone();
    let app2 = app.clone();
    let asset_ids = request.asset_ids.clone();
    let filter = request.filter.clone();
    let export = request.export.clone();

    tokio::task::spawn_blocking(move || {
        let pool = state_inner.pool.clone();
        let mut assets_list: Vec<(i64, PathBuf)> = Vec::new();
        let rt = tokio::runtime::Handle::current();
        for id in &asset_ids {
            let a = rt.block_on(crate::db::assets::get(&pool, *id));
            if let Ok(asset) = a {
                assets_list.push((asset.id, PathBuf::from(asset.file_path)));
            }
        }

        let total = assets_list.len() as i64;
        let completed = AtomicI64::new(0);
        let failed = AtomicI64::new(0);

        // 关键：用 state.export_pool（线程数 = 2）而不是全局 rayon 池。
        // install 让闭包内所有 par_iter 都跑在受限线程池里，
        // 进而把"并发处理中的大图数量"硬卡在 2，内存峰值可预测。
        state_inner.export_pool.install(|| {
            assets_list.par_iter().for_each(|(asset_id, src_path)| {
                let dest_res = export::resolve_destination_dir(src_path, &export.destination);
                let result: Result<PathBuf> = match dest_res {
                    Ok(dest) => export::export_one(
                        src_path,
                        &dest,
                        &filter,
                        &export,
                        lut.as_deref(),
                    ),
                    Err(e) => Err(e),
                };
                match &result {
                    Ok(out) => {
                        let _ = rt.block_on(crate::db::tasks::record_generation(
                            &pool,
                            task_id,
                            *asset_id,
                            Some(out.to_string_lossy().as_ref()),
                            "Success",
                            None,
                        ));
                        let _ = rt.block_on(crate::db::tasks::bump_progress(&pool, task_id, true));
                        completed.fetch_add(1, Ordering::SeqCst);
                        let progress = BatchProgress {
                            task_id,
                            total,
                            completed: completed.load(Ordering::SeqCst),
                            failed: failed.load(Ordering::SeqCst),
                            last_asset_id: Some(*asset_id),
                            last_output: Some(out.to_string_lossy().to_string()),
                            last_error: None,
                            done: false,
                        };
                        let _ = app2.emit("export:progress", &progress);
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        let _ = rt.block_on(crate::db::tasks::record_generation(
                            &pool,
                            task_id,
                            *asset_id,
                            None,
                            "Error",
                            Some(&msg),
                        ));
                        let _ = rt.block_on(crate::db::tasks::bump_progress(&pool, task_id, false));
                        failed.fetch_add(1, Ordering::SeqCst);
                        let progress = BatchProgress {
                            task_id,
                            total,
                            completed: completed.load(Ordering::SeqCst),
                            failed: failed.load(Ordering::SeqCst),
                            last_asset_id: Some(*asset_id),
                            last_output: None,
                            last_error: Some(msg),
                            done: false,
                        };
                        let _ = app2.emit("export:progress", &progress);
                    }
                }
            });
        });

        let _ = rt.block_on(crate::db::tasks::finish(&pool, task_id));
        let final_progress = BatchProgress {
            task_id,
            total,
            completed: completed.load(Ordering::SeqCst),
            failed: failed.load(Ordering::SeqCst),
            last_asset_id: None,
            last_output: None,
            last_error: None,
            done: true,
        };
        let _ = app2.emit("export:progress", &final_progress);
    });

    Ok(task_id)
}

#[tauri::command]
pub async fn list_recent_tasks(state: State<'_, SharedState>) -> Result<Vec<tasks::BatchTask>> {
    tasks::list_recent(&state.pool, 20).await
}

#[tauri::command]
pub async fn get_task(state: State<'_, SharedState>, id: i64) -> Result<Option<tasks::BatchTask>> {
    tasks::get(&state.pool, id).await
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

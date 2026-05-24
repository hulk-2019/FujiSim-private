//! 资产导入、查询和文件操作。

use crate::asset::{fileops, scanner};
use crate::db::{albums, assets};
use crate::error::{AppError, Result};
use crate::processing;
use crate::state::SharedState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, State};

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
    start_exif_worker(state.inner().clone(), app.clone());
    Ok(report)
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
    start_exif_worker(state.inner().clone(), app.clone());
    Ok(report)
}

#[tauri::command]
pub async fn list_assets(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    query: assets::AssetQuery,
) -> Result<assets::ListAssetsResult> {
    let result = assets::list(&state.pool, &query).await?;
    let ids: Vec<i64> = result
        .items
        .iter()
        .filter(|a| a.is_raw != 0 && a.cover_path.is_none())
        .map(|a| a.id)
        .collect();
    if !ids.is_empty() {
        state.cover_queue.enqueue(ids, state.inner().clone(), app);
    }
    Ok(result)
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

/// 在系统文件管理器中定位并高亮指定路径。
/// macOS Finder / Windows Explorer / Linux 退化为打开父目录。
#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<()> {
    let p = PathBuf::from(path);
    fileops::reveal_in_file_manager(&p)
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

/// 懒加载 RAW 嵌入原图：优先查数据库 preview_path，命中且文件存在时直接返回。
/// 未命中时提取嵌入 JPEG（含 orientation 校正）写盘，更新 preview_path，返回路径。
/// token 与 get_preview 共享，用于快速切换时提前取消。
#[tauri::command]
pub async fn get_raw_original(
    state: State<'_, SharedState>,
    asset_id: i64,
    token: u64,
) -> Result<String> {
    use std::sync::atomic::Ordering;
    state.preview_token.store(token, Ordering::SeqCst);

    let asset = assets::get(&state.pool, asset_id).await?;

    // 数据库缓存命中：路径存在且文件在磁盘上
    if let Some(ref p) = asset.preview_path {
        if std::path::Path::new(p).exists() {
            return Ok(p.clone());
        }
    }

    let mtime = std::path::Path::new(&asset.file_path)
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cache_path = state
        .raw_original_dir
        .join(format!("{asset_id}_{mtime}.jpg"));

    // 磁盘缓存命中（数据库未记录但文件已存在）
    if cache_path.exists() {
        let path_str = cache_path.to_string_lossy().to_string();
        let pool = state.pool.clone();
        let path_for_db = path_str.clone();
        tokio::spawn(async move {
            let _ = assets::update_preview_path(&pool, asset_id, &path_for_db).await;
        });
        return Ok(path_str);
    }

    let file_path = std::path::PathBuf::from(&asset.file_path);
    let sem = state.io_sem.clone();
    let pool = state.pool.clone();
    let preview_token = state.preview_token.clone();
    let rt = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let _permit = rt.block_on(sem.acquire_owned()).ok();
        // 等到拿到 permit 后检查 token，可能已有更新的请求
        if preview_token.load(Ordering::SeqCst) != token {
            return Err(AppError::other("preview_cancelled"));
        }
        let bytes = processing::raw::extract_raw_thumbnail(&file_path)?;
        std::fs::write(&cache_path, &bytes)
            .map_err(|e| AppError::other(format!("raw_original write: {e}")))?;
        let path_str = cache_path.to_string_lossy().to_string();
        let path_for_db = path_str.clone();
        let rt2 = tokio::runtime::Handle::current();
        rt2.spawn(async move {
            let _ = assets::update_preview_path(&pool, asset_id, &path_for_db).await;
        });
        Ok(path_str)
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
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
            if batch.is_empty() {
                break;
            }

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
                    let (exif, width, height) =
                        crate::asset::scanner::extract_exif_only(path, kind);
                    let rt = tokio::runtime::Handle::current();
                    let _ = rt.block_on(crate::db::assets::update_exif(
                        &pool, asset.id, &exif, width, height,
                    ));
                    let _ = app2.emit("exif:item_done", asset.id);
                })
                .await;
            }
            let _ = app.emit("exif:batch_done", ());
        }
    });
}

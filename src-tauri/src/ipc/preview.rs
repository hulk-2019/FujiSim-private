//! 实时预览渲染、封面缓存目录、白平衡与取色器。

use crate::db::assets;
use crate::error::{AppError, Result};
use crate::processing::{self, FilterSettings};
use crate::state::{PreviewBaseCacheKey, Rgb16Image, SharedState};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tauri::State;

const DISK_PREVIEW_BASE_MAX_EDGE: u32 = 1920;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewMode {
    Interactive,
    Settled,
    Full,
    Tile,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTileRequest {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub output_width: u32,
    pub output_height: u32,
}

/// 预览结果。
///
/// `interactive` / `settled` 返回后端权威 JPEG bytes，前端创建 Blob URL，避免临时文件写盘
/// 和 WebView 再读盘；`full` 仍返回 path，避免超大 IPC payload。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub path: Option<String>,
    pub data: Option<Vec<u8>>,
    pub mime_type: Option<String>,
    pub width: u32,
    pub height: u32,
}

/// `thumbnail:done` 事件载荷：单张封面写盘完成。
#[derive(Debug, Serialize, Clone)]
pub struct ThumbnailDonePayload {
    pub asset_id: i64,
}

/// 快速判断 RAW 的预览基线是否已经解析完成。
///
/// 只检查 `{asset_id}_baseline.tif` 是否存在，不做解码；用于前端决定是否需要展示首次解析 loading。
#[tauri::command]
pub async fn has_preview_base(
    state: State<'_, SharedState>,
    asset_id: i64,
    project_id: Option<i64>,
) -> Result<bool> {
    Ok(processing::raw::preview_base_path(&state.raw_original_dir, project_id, asset_id).exists())
}

/// Frontend-only interaction marker. Used when WebGL handles immediate feedback
/// without calling `get_preview`, so background queues still yield to the editor.
#[tauri::command]
pub async fn mark_preview_interaction(state: State<'_, SharedState>, duration_ms: Option<u64>) -> Result<()> {
    state.mark_interaction_active_for(duration_ms.unwrap_or(900).clamp(100, 5000));
    Ok(())
}

/// 返回已解析 RAW baseline TIFF 的路径和尺寸。
///
/// 用于切回已经完成首次解析的 RAW 时直接显示 baseline，避免先进入骨架屏。
#[tauri::command]
pub async fn get_preview_base(
    state: State<'_, SharedState>,
    asset_id: i64,
    project_id: Option<i64>,
) -> Result<Option<PreviewResult>> {
    let path = processing::raw::preview_base_path(&state.raw_original_dir, project_id, asset_id);
    if !path.exists() {
        return Ok(None);
    }
    let (width, height) = crate::vips_io::image_dimensions(&path)?;
    Ok(Some(PreviewResult {
        path: Some(path.to_string_lossy().to_string()),
        data: None,
        mime_type: Some("image/tiff".to_string()),
        width,
        height,
    }))
}

/// 实时渲染单张照片的预览图。每次调用都重新解码 + 下采样 + 色彩流水线，
/// 结果写入系统临时目录下的文件，返回路径供前端 convertFileSrc 加载。
/// token 用于取消：前端每次切换文件时递增 token，后端在解码完成后检查，
/// 若 token 已过期则返回 preview_cancelled，前端静默丢弃。
#[tauri::command]
pub async fn get_preview(
    state: State<'_, SharedState>,
    asset_id: i64,
    settings: Option<FilterSettings>,
    mode: PreviewMode,
    max_edge: Option<u32>,
    token: u64,
    tile: Option<PreviewTileRequest>,
    project_id: Option<i64>,
) -> Result<PreviewResult> {
    use std::sync::atomic::Ordering;
    let is_tile = matches!(mode, PreviewMode::Tile);
    if is_tile {
        state.tile_token.store(token, Ordering::SeqCst);
    } else {
        // 主预览优先级高于 tile refinement，所以主预览更新也会打断旧 tile。
        state.preview_token.store(token, Ordering::SeqCst);
        state.tile_token.store(token, Ordering::SeqCst);
    }
    state.mark_preview_active_for(1500);

    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);
    let native_max_edge = asset
        .width
        .zip(asset.height)
        .map(|(w, h)| w.max(h).max(1) as u32);
    let settings = settings.unwrap_or_default();
    let lut = super::cached_lut(&state, settings.lut_file_path.as_deref())?;
    let preview_pool = state.preview_pool.clone();
    let sem = if is_tile {
        state.tile_sem.clone()
    } else {
        state.preview_sem.clone()
    };
    let preview_token = state.preview_token.clone();
    let tile_token = state.tile_token.clone();
    let preview_generation = preview_token.load(Ordering::SeqCst);
    let state_for_render = state.inner().clone();
    let project_id_for_render = project_id;

    let permit = sem
        .try_acquire_owned()
        .map_err(|_| AppError::other("preview_busy"))?;

    // 等到拿到 permit 后再检查一次，可能已经有更新的请求进来了
    if request_cancelled(is_tile, token, preview_generation, &preview_token, &tile_token) {
        return Err(AppError::other("preview_cancelled"));
    }

    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        preview_pool.install(|| {
            let total_start = Instant::now();
            tracing::debug!(asset_id, token, ?mode, ?max_edge, "preview render start");

            let persist_to_disk = matches!(mode, PreviewMode::Settled)
                && max_edge.is_some_and(|edge| edge >= DISK_PREVIEW_BASE_MAX_EDGE);
            let base_start = Instant::now();
            let resized = load_preview_base(
                &state_for_render,
                asset_id,
                &path,
                if is_tile { None } else { max_edge },
                native_max_edge,
                persist_to_disk,
                project_id_for_render,
            )?;
            let resized = if is_tile {
                Arc::new(crop_tile(&resized, tile.ok_or_else(|| AppError::other("preview_tile_required"))?)?)
            } else {
                resized
            };
            let base_ms = base_start.elapsed().as_millis();

            // Check token after decode (decode is the most expensive part)
            if request_cancelled(is_tile, token, preview_generation, &preview_token, &tile_token) {
                return Err(AppError::other("preview_cancelled"));
            }

            let interactive_preview = matches!(mode, PreviewMode::Interactive | PreviewMode::Tile);
            let render_settings = if interactive_preview {
                settings.interactive_preview()
            } else {
                settings.clone()
            };
            let (rw, rh) = resized.dimensions();
            let process_start = Instant::now();
            let processed =
                crate::processing::process_image(&resized, &render_settings, lut.as_deref())?;
            let process_ms = process_start.elapsed().as_millis();
            if request_cancelled(is_tile, token, preview_generation, &preview_token, &tile_token) {
                return Err(AppError::other("preview_cancelled"));
            }
            let jpeg_quality = if interactive_preview {
                78
            } else {
                88
            };
            let encode_start = Instant::now();
            let jpeg =
                crate::vips_io::encode_rgb16(&processed, crate::export::ExportFormat::Jpeg, jpeg_quality)?;
            let encode_ms = encode_start.elapsed().as_millis();
            if request_cancelled(is_tile, token, preview_generation, &preview_token, &tile_token) {
                return Err(AppError::other("preview_cancelled"));
            }
            let transport_start = Instant::now();
            let (path, data) = if matches!(mode, PreviewMode::Full) {
                let variant = if settings.is_identity() { "base" } else { "edit" };
                let out_path =
                    std::env::temp_dir().join(format!("fujisim_preview_{asset_id}_{token}_{variant}.jpg"));
                std::fs::write(&out_path, &jpeg)
                    .map_err(|e| AppError::other(format!("preview write: {e}")))?;
                (Some(out_path.to_string_lossy().to_string()), None)
            } else {
                (None, Some(jpeg))
            };
            let transport_ms = transport_start.elapsed().as_millis();
            let bytes = data.as_ref().map(|d| d.len()).unwrap_or(0);
            tracing::debug!(
                asset_id,
                token,
                ?mode,
                ?max_edge,
                width = rw,
                height = rh,
                base_ms,
                process_ms,
                encode_ms,
                transport_ms,
                bytes,
                total_ms = total_start.elapsed().as_millis(),
                "preview render finished"
            );
            Ok(PreviewResult {
                path,
                data,
                mime_type: Some("image/jpeg".to_string()),
                width: rw,
                height: rh,
            })
        })
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}

fn request_cancelled(
    is_tile: bool,
    token: u64,
    preview_generation: u64,
    preview_token: &std::sync::atomic::AtomicU64,
    tile_token: &std::sync::atomic::AtomicU64,
) -> bool {
    use std::sync::atomic::Ordering;
    if is_tile {
        tile_token.load(Ordering::SeqCst) != token
            || preview_token.load(Ordering::SeqCst) != preview_generation
    } else {
        preview_token.load(Ordering::SeqCst) != token
    }
}

pub(crate) fn load_preview_base(
    state: &SharedState,
    asset_id: i64,
    path: &std::path::Path,
    max_edge: Option<u32>,
    native_max_edge: Option<u32>,
    persist_to_disk: bool,
    project_id: Option<i64>,
) -> Result<Arc<Rgb16Image>> {
    let key = PreviewBaseCacheKey { asset_id, max_edge };

    if let Ok(mut cache) = state.preview_base_cache.lock() {
        if let Some(img) = cache.get(key) {
            tracing::debug!(asset_id, ?max_edge, "preview base memory cache hit");
            return Ok(img);
        }
    }

    let cache_path = processing::raw::preview_base_path(&state.raw_original_dir, project_id, asset_id);
    let use_disk_base = matches!(
        crate::asset::format::classify(path),
        crate::asset::format::FileKind::Raw
    );
    let mut should_write_disk = false;
    let img = if use_disk_base && cache_path.exists() {
        match crate::vips_io::decode_to_rgb16(&cache_path) {
            Ok(img) if disk_base_satisfies_request(&img, max_edge, native_max_edge) => {
                tracing::debug!(asset_id, ?max_edge, "preview base disk cache hit");
                resize_to_max_edge(img, max_edge)?
            }
            _ => {
                tracing::debug!(asset_id, ?max_edge, "preview base disk cache stale");
                should_write_disk = persist_to_disk;
                decode_and_resize(path, max_edge)?
            }
        }
    } else {
        tracing::debug!(asset_id, ?max_edge, "preview base cache miss");
        should_write_disk = use_disk_base && persist_to_disk;
        decode_and_resize(path, max_edge)?
    };

    if use_disk_base && should_write_disk {
        if let Some(parent) = cache_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = crate::vips_io::encode_rgb16_to_file(
            &img,
            &cache_path,
            crate::export::ExportFormat::Tiff,
            0,
        ) {
            tracing::warn!("failed to cache preview base for asset {}: {}", asset_id, e);
        }
    }

    let img = Arc::new(img);
    if let Ok(mut cache) = state.preview_base_cache.lock() {
        cache.insert(key, img.clone());
    }
    Ok(img)
}

fn disk_base_satisfies_request(
    img: &Rgb16Image,
    max_edge: Option<u32>,
    native_max_edge: Option<u32>,
) -> bool {
    let requested_output_edge = match (max_edge, native_max_edge) {
        (Some(requested), Some(native)) => native.min(requested),
        (Some(requested), None) => requested,
        (None, Some(native)) => native,
        (None, None) => return false,
    };
    img.width().max(img.height()) >= requested_output_edge
}

fn decode_and_resize(
    path: &std::path::Path,
    max_edge: Option<u32>,
) -> crate::error::Result<Rgb16Image> {
    use crate::asset::format::{classify, FileKind};
    use crate::processing;
    let src = match classify(path) {
        FileKind::Raw => processing::raw::decode_raw_rgb16_for_preview(path, max_edge)?,
        _ => processing::load_image_rgb16(path)?,
    };
    resize_to_max_edge(src, max_edge)
}

fn resize_to_max_edge(src: Rgb16Image, max_edge: Option<u32>) -> Result<Rgb16Image> {
    let Some(me) = max_edge else {
        return Ok(src);
    };
    let (w, h) = src.dimensions();
    let scale = (me as f32 / w.max(h) as f32).min(1.0);
    if scale < 1.0 {
        let nw = (w as f32 * scale).round().max(1.0) as u32;
        let nh = (h as f32 * scale).round().max(1.0) as u32;
        crate::vips_io::resize_rgb16(&src, nw, nh)
    } else {
        Ok(src)
    }
}

fn crop_tile(src: &Rgb16Image, tile: PreviewTileRequest) -> Result<Rgb16Image> {
    let (src_w, src_h) = src.dimensions();
    if src_w == 0 || src_h == 0 {
        return Err(AppError::other("empty preview base"));
    }

    let x = tile.x.min(src_w.saturating_sub(1));
    let y = tile.y.min(src_h.saturating_sub(1));
    let width = tile.width.max(1).min(src_w - x);
    let height = tile.height.max(1).min(src_h - y);
    let output_width = tile.output_width.max(1).min(4096);
    let output_height = tile.output_height.max(1).min(4096);
    let cropped = image::imageops::crop_imm(src, x, y, width, height).to_image();

    if cropped.width() == output_width && cropped.height() == output_height {
        Ok(cropped)
    } else {
        crate::vips_io::resize_rgb16(&cropped, output_width, output_height)
    }
}

/// 返回封面图缓存目录的绝对路径，供前端拼接 convertFileSrc 使用。
#[tauri::command]
pub async fn get_cover_dir(state: State<'_, SharedState>) -> Result<String> {
    Ok(state.cover_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn set_cover_concurrency(state: State<'_, SharedState>, n: usize) -> Result<()> {
    state.cover_queue.set_concurrency(n);
    Ok(())
}

/// 使用 Gray World 算法计算自动白平衡偏移量。
///
/// 返回 `(wb_shift_r, wb_shift_g, wb_shift_b)`，范围 -100..100（整数）。
#[tauri::command]
pub async fn auto_white_balance(
    state: State<'_, SharedState>,
    asset_id: i64,
) -> Result<(i32, i32, i32)> {
    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);
    let export_pool = state.export_pool.clone();

    tokio::task::spawn_blocking(move || {
        export_pool.install(|| {
            let img = processing::load_image_rgb16(&path)?;
            Ok(processing::white_balance::auto_white_balance(&img))
        })
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}

/// 从指定资产的源图像中采样 (x, y) 位置的像素 RGB 值。
///
/// 返回 `(R, G, B)`，范围 0..65535（16-bit）。
#[tauri::command]
pub async fn eyedrop_color(
    state: State<'_, SharedState>,
    asset_id: i64,
    x: u32,
    y: u32,
) -> Result<(f32, f32, f32)> {
    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);
    let export_pool = state.export_pool.clone();

    tokio::task::spawn_blocking(move || {
        export_pool.install(|| {
            let img = processing::load_image_rgb16(&path)?;
            let (w, h) = img.dimensions();
            if x >= w || y >= h {
                return Err(AppError::other(format!(
                    "eyedrop out of bounds: ({x}, {y}) exceeds ({w}, {h})"
                )));
            }
            Ok(processing::white_balance::eyedrop_color(&img, x, y))
        })
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}

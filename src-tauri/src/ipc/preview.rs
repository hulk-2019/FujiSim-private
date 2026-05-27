//! 实时预览渲染、封面缓存目录、白平衡与取色器。

use crate::db::assets;
use crate::error::{AppError, Result};
use crate::processing::{self, FilterSettings};
use crate::state::{PreviewBaseCacheKey, Rgb16Image, SharedState};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

/// 预览结果。前端用 convertFileSrc(path) 加载本地文件，零 IPC 传输开销。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub path: String,
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
pub async fn has_preview_base(state: State<'_, SharedState>, asset_id: i64) -> Result<bool> {
    Ok(processing::raw::preview_base_path(&state.raw_original_dir, asset_id).exists())
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
    max_edge: Option<u32>,
    token: u64,
) -> Result<PreviewResult> {
    use std::sync::atomic::Ordering;
    // 注册为当前最新 token，同时让旧的请求在检查时发现自己已过期
    state.preview_token.store(token, Ordering::SeqCst);

    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);
    let settings = settings.unwrap_or_default();
    let lut = super::cached_lut(&state, settings.lut_file_path.as_deref())?;
    let export_pool = state.export_pool.clone();
    let sem = state.preview_sem.clone();
    let preview_token = state.preview_token.clone();
    let state_for_render = state.inner().clone();

    let permit = sem
        .acquire_owned()
        .await
        .map_err(|_| AppError::other("preview_busy"))?;

    // 等到拿到 permit 后再检查一次，可能已经有更新的请求进来了
    if preview_token.load(Ordering::SeqCst) != token {
        return Err(AppError::other("preview_cancelled"));
    }

    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        export_pool.install(|| {
            let resized = load_preview_base(&state_for_render, asset_id, &path, max_edge, true)?;

            // Check token after decode (decode is the most expensive part)
            if preview_token.load(Ordering::SeqCst) != token {
                return Err(AppError::other("preview_cancelled"));
            }

            let (rw, rh) = resized.dimensions();
            let processed = crate::processing::process_image(&resized, &settings, lut.as_deref())?;
            if preview_token.load(Ordering::SeqCst) != token {
                return Err(AppError::other("preview_cancelled"));
            }
            let jpeg =
                crate::vips_io::encode_rgb16(&processed, crate::export::ExportFormat::Jpeg, 88)?;
            if preview_token.load(Ordering::SeqCst) != token {
                return Err(AppError::other("preview_cancelled"));
            }
            let variant = if settings.is_identity() { "base" } else { "edit" };
            let out_path =
                std::env::temp_dir().join(format!("fujisim_preview_{asset_id}_{token}_{variant}.jpg"));
            std::fs::write(&out_path, &jpeg)
                .map_err(|e| AppError::other(format!("preview write: {e}")))?;
            Ok(PreviewResult {
                path: out_path.to_string_lossy().to_string(),
                width: rw,
                height: rh,
            })
        })
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}

pub(crate) fn load_preview_base(
    state: &SharedState,
    asset_id: i64,
    path: &std::path::Path,
    max_edge: Option<u32>,
    persist_to_disk: bool,
) -> Result<Arc<Rgb16Image>> {
    let key = PreviewBaseCacheKey { asset_id, max_edge };

    if let Ok(mut cache) = state.preview_base_cache.lock() {
        if let Some(img) = cache.get(key) {
            return Ok(img);
        }
    }

    let cache_path = processing::raw::preview_base_path(&state.raw_original_dir, asset_id);
    let img = if cache_path.exists() {
        match crate::vips_io::decode_to_rgb16(&cache_path).and_then(|img| resize_to_max_edge(img, max_edge)) {
            Ok(img) => img,
            Err(_) => decode_and_resize(path, max_edge)?,
        }
    } else {
        decode_and_resize(path, max_edge)?
    };

    if persist_to_disk && !cache_path.exists() {
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

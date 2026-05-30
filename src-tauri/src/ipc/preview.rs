//! 实时预览渲染、封面缓存目录、白平衡与取色器。

use crate::db::assets;
use crate::error::{AppError, Result};
use crate::processing::{self, FilterSettings};
use crate::state::{PreviewBaseCacheKey, PreviewBaseCacheKind, Rgb16Image, SharedState};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tauri::State;

const RAW_PREVIEW_PROXY_MAX_EDGE: u32 = 2048;
const WHITE_BALANCE_SAMPLE_MAX_EDGE: u32 = 2048;
const BASELINE_DISK_CACHE_KIND: &str = "preview_baseline";
const BASELINE_DISK_CACHE_VERSION: i64 = 1;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<u32>,
}

pub(crate) fn baseline_disk_cache_key(
    asset_id: i64,
    file_path: &Path,
    file_size: Option<i64>,
    max_edge: Option<u32>,
    native_max_edge: Option<u32>,
) -> String {
    let path_hash = stable_hash(&file_path.to_string_lossy());
    format!(
        "v{BASELINE_DISK_CACHE_VERSION}:asset={asset_id}:path={path_hash}:size={}:max={}:native={}",
        file_size.unwrap_or_default(),
        max_edge.map(|v| v.to_string()).unwrap_or_else(|| "native".to_string()),
        native_max_edge.map(|v| v.to_string()).unwrap_or_else(|| "unknown".to_string()),
    )
}

pub(crate) fn baseline_disk_cache_path(cache_dir: &Path, asset_id: i64, cache_key: &str) -> PathBuf {
    cache_dir.join(format!("{asset_id}_{}.jpg", stable_hash(cache_key)))
}

fn preview_result_from_baseline_cache_bytes(
    bytes: Vec<u8>,
    width: u32,
    height: u32,
) -> PreviewResult {
    PreviewResult {
        path: None,
        data: Some(bytes),
        mime_type: Some("image/jpeg".to_string()),
        width,
        height,
        orientation: None,
    }
}

fn stable_hash(input: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Frontend-only interaction marker. Used when WebGL handles immediate feedback
/// without calling `get_preview`, so background queues still yield to the editor.
#[tauri::command]
pub async fn mark_preview_interaction(
    state: State<'_, SharedState>,
    duration_ms: Option<u64>,
) -> Result<()> {
    state.mark_interaction_active_for(duration_ms.unwrap_or(900).clamp(100, 5000));
    Ok(())
}

/// 返回可秒开的预览图：RAW 直接返回相机内嵌 JPEG，普通图片使用源文件下采样。
///
/// 这张图只作为首帧占位；最终显示仍由 `get_preview` 的 RAW 解码与色彩流水线替换。
#[tauri::command]
pub async fn get_fast_preview(
    state: State<'_, SharedState>,
    asset_id: i64,
    max_edge: Option<u32>,
    token: u64,
) -> Result<PreviewResult> {
    state.mark_preview_active_for(800);

    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);
    let preview_pool = state.preview_pool.clone();
    let max_edge = max_edge.unwrap_or(1920).clamp(320, 4096);

    tokio::task::spawn_blocking(move || {
        preview_pool.install(|| {
            let _ = token;
            let start = Instant::now();
            let (jpeg, width, height, orientation) = if asset.is_raw != 0 {
                let (jpeg, orientation) = processing::raw::extract_raw_thumbnail_fast(&path)?;
                let width = asset.width.unwrap_or(0).max(0) as u32;
                let height = asset.height.unwrap_or(0).max(0) as u32;
                (jpeg, width, height, Some(orientation).filter(|o| *o > 1))
            } else {
                let img = processing::load_image_rgb16(&path)?;
                let img = resize_to_max_edge(img, Some(max_edge))?;
                let (width, height) = img.dimensions();
                let jpeg =
                    crate::vips_io::encode_rgb16(&img, crate::export::ExportFormat::Jpeg, 86)?;
                (jpeg, width, height, None)
            };
            tracing::debug!(
                asset_id,
                width,
                height,
                bytes = jpeg.len(),
                total_ms = start.elapsed().as_millis(),
                "fast preview ready"
            );
            Ok(PreviewResult {
                path: None,
                data: Some(jpeg),
                mime_type: Some("image/jpeg".to_string()),
                width,
                height,
                orientation,
            })
        })
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}

/// 缩略图直接读取源文件。RAW 优先返回接近 256px 长边的相机内嵌 JPEG；
/// 普通图片返回原始 path，由浏览器按缩略格显示。
#[tauri::command]
pub async fn get_asset_thumbnail(
    state: State<'_, SharedState>,
    asset_id: i64,
) -> Result<PreviewResult> {
    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);

    if asset.is_raw == 0 {
        return Ok(PreviewResult {
            path: Some(asset.file_path),
            data: None,
            mime_type: None,
            width: asset.width.unwrap_or(0).max(0) as u32,
            height: asset.height.unwrap_or(0).max(0) as u32,
            orientation: None,
        });
    }

    let permit = state
        .io_sem
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| AppError::other(e.to_string()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let (jpeg, width, height, orientation) =
            processing::raw::extract_raw_thumbnail_fast_for_edge(&path, 256)?;
        Ok(PreviewResult {
            path: None,
            data: Some(jpeg),
            mime_type: Some("image/jpeg".to_string()),
            width,
            height,
            orientation: Some(orientation).filter(|o| *o > 1),
        })
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}

/// 实时渲染单张照片的预览图。RAW 会直接从源文件解码到内存基线，
/// 再走下采样 + 色彩流水线。
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
    let can_use_baseline_disk_cache = matches!(mode, PreviewMode::Settled) && settings.is_identity();
    let baseline_cache_key = can_use_baseline_disk_cache.then(|| {
        baseline_disk_cache_key(
            asset_id,
            &path,
            asset.file_size,
            max_edge,
            native_max_edge,
        )
    });
    if let Some(cache_key) = baseline_cache_key.as_deref() {
        if let Some(hit) = crate::db::asset_render_cache::get(
            &state.pool,
            asset_id,
            BASELINE_DISK_CACHE_KIND,
            cache_key,
        )
        .await?
        {
            let cache_path = PathBuf::from(&hit.path);
            if cache_path.exists() {
                let bytes = std::fs::read(&cache_path)
                    .map_err(|e| AppError::other(format!("preview cache read: {e}")))?;
                tracing::debug!(
                    asset_id,
                    ?max_edge,
                    path = %cache_path.display(),
                    "preview baseline disk cache hit"
                );
                return Ok(preview_result_from_baseline_cache_bytes(
                    bytes,
                    hit.width.or(asset.width).unwrap_or_default() as u32,
                    hit.height.or(asset.height).unwrap_or_default() as u32,
                ));
            }
        }
    }
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
    let baseline_cache_key_for_render = baseline_cache_key.clone();

    let permit = sem
        .try_acquire_owned()
        .map_err(|_| AppError::other("preview_busy"))?;

    // 等到拿到 permit 后再检查一次，可能已经有更新的请求进来了
    if request_cancelled(
        is_tile,
        token,
        preview_generation,
        &preview_token,
        &tile_token,
    ) {
        return Err(AppError::other("preview_cancelled"));
    }

    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        preview_pool.install(|| {
            let total_start = Instant::now();
            tracing::debug!(asset_id, token, ?mode, ?max_edge, "preview render start");

            let base_start = Instant::now();
            let resized = load_preview_base(
                &state_for_render,
                asset_id,
                &path,
                if is_tile { None } else { max_edge },
                native_max_edge,
                project_id_for_render,
            )?;
            let resized = if is_tile {
                Arc::new(crop_tile(
                    &resized,
                    tile.ok_or_else(|| AppError::other("preview_tile_required"))?,
                )?)
            } else {
                resized
            };
            let base_ms = base_start.elapsed().as_millis();

            // Check token after decode (decode is the most expensive part)
            if request_cancelled(
                is_tile,
                token,
                preview_generation,
                &preview_token,
                &tile_token,
            ) {
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
            if request_cancelled(
                is_tile,
                token,
                preview_generation,
                &preview_token,
                &tile_token,
            ) {
                return Err(AppError::other("preview_cancelled"));
            }
            let jpeg_quality = if interactive_preview { 78 } else { 88 };
            let encode_start = Instant::now();
            let jpeg = crate::vips_io::encode_rgb16(
                &processed,
                crate::export::ExportFormat::Jpeg,
                jpeg_quality,
            )?;
            let encode_ms = encode_start.elapsed().as_millis();
            if request_cancelled(
                is_tile,
                token,
                preview_generation,
                &preview_token,
                &tile_token,
            ) {
                return Err(AppError::other("preview_cancelled"));
            }
            let transport_start = Instant::now();
            let baseline_cache_path = baseline_cache_key_for_render.as_deref().map(|cache_key| {
                baseline_disk_cache_path(
                    &state_for_render.preview_baseline_dir,
                    asset_id,
                    cache_key,
                )
            });
            if let Some(out_path) = baseline_cache_path {
                std::fs::create_dir_all(&state_for_render.preview_baseline_dir)
                    .map_err(|e| AppError::other(format!("preview cache mkdir: {e}")))?;
                std::fs::write(&out_path, &jpeg)
                    .map_err(|e| AppError::other(format!("preview cache write: {e}")))?;
            }
            let (path, data) = if matches!(mode, PreviewMode::Full) {
                let variant = if settings.is_identity() {
                    "base"
                } else {
                    "edit"
                };
                let out_path = std::env::temp_dir()
                    .join(format!("fujisim_preview_{asset_id}_{token}_{variant}.jpg"));
                std::fs::write(&out_path, &jpeg)
                    .map_err(|e| AppError::other(format!("preview write: {e}")))?;
                let path = out_path.to_string_lossy().to_string();
                (Some(path), None)
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
                orientation: None,
            })
        })
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))??;

    if let Some(cache_key) = baseline_cache_key.as_deref() {
        let cache_path = baseline_disk_cache_path(&state.preview_baseline_dir, asset_id, cache_key);
        let cache_path = cache_path.to_string_lossy().to_string();
        crate::db::asset_render_cache::upsert(
            &state.pool,
            asset_id,
            BASELINE_DISK_CACHE_KIND,
            cache_key,
            &cache_path,
            Some(result.width as i64),
            Some(result.height as i64),
            BASELINE_DISK_CACHE_VERSION,
            None,
        )
        .await?;
    }

    Ok(result)
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
    project_id: Option<i64>,
) -> Result<Arc<Rgb16Image>> {
    let _ = project_id;
    use crate::asset::format::classify;

    let file_kind = classify(path);
    let cache_max_edge = preview_base_cache_max_edge(file_kind, max_edge);
    let display_key = PreviewBaseCacheKey {
        asset_id,
        max_edge,
        kind: PreviewBaseCacheKind::Display,
    };

    if let Ok(mut cache) = state.preview_base_cache.lock() {
        if let Some(img) = cache.get(display_key) {
            tracing::debug!(
                asset_id,
                ?max_edge,
                "preview display base memory cache hit"
            );
            return Ok(img);
        }
    }

    let proxy = load_preview_proxy(
        state,
        asset_id,
        path,
        file_kind,
        cache_max_edge,
        native_max_edge,
    )?;
    let derive_start = Instant::now();
    let display = derive_preview_base(proxy, file_kind, max_edge)?;
    let derive_ms = derive_start.elapsed().as_millis();
    if let Ok(mut cache) = state.preview_base_cache.lock() {
        cache.insert(display_key, display.clone());
    }
    tracing::debug!(
        asset_id,
        ?max_edge,
        derive_ms,
        "preview display base derived"
    );
    Ok(display)
}

fn preview_base_cache_max_edge(
    file_kind: crate::asset::format::FileKind,
    requested_max_edge: Option<u32>,
) -> Option<u32> {
    match file_kind {
        crate::asset::format::FileKind::Raw => {
            requested_max_edge.map(|_| RAW_PREVIEW_PROXY_MAX_EDGE)
        }
        _ => requested_max_edge,
    }
}

fn decode_preview_proxy(
    path: &std::path::Path,
    max_edge: Option<u32>,
    file_kind: crate::asset::format::FileKind,
) -> crate::error::Result<Rgb16Image> {
    use crate::processing;
    let src = match file_kind {
        crate::asset::format::FileKind::Raw => {
            processing::raw::decode_raw_linear_rgb16_for_preview(path, max_edge)?
        }
        _ => processing::load_image_rgb16(path)?,
    };
    resize_to_max_edge(src, max_edge)
}

fn load_preview_proxy(
    state: &SharedState,
    asset_id: i64,
    path: &std::path::Path,
    file_kind: crate::asset::format::FileKind,
    cache_max_edge: Option<u32>,
    native_max_edge: Option<u32>,
) -> Result<Arc<Rgb16Image>> {
    let proxy_key = PreviewBaseCacheKey {
        asset_id,
        max_edge: cache_max_edge,
        kind: match file_kind {
            crate::asset::format::FileKind::Raw => PreviewBaseCacheKind::LinearProxy,
            _ => PreviewBaseCacheKind::Display,
        },
    };

    if let Ok(mut cache) = state.preview_base_cache.lock() {
        if let Some(img) = cache.get(proxy_key) {
            tracing::debug!(
                asset_id,
                ?cache_max_edge,
                "preview proxy memory cache hit"
            );
            return Ok(img);
        }
    }

    tracing::debug!(
        asset_id,
        ?cache_max_edge,
        ?native_max_edge,
        "preview proxy memory cache miss"
    );
    let decode_start = Instant::now();
    let img = Arc::new(decode_preview_proxy(path, cache_max_edge, file_kind)?);
    let decode_ms = decode_start.elapsed().as_millis();
    if let Ok(mut cache) = state.preview_base_cache.lock() {
        cache.insert(proxy_key, img.clone());
    }
    tracing::debug!(
        asset_id,
        ?cache_max_edge,
        decode_ms,
        "preview proxy decoded"
    );
    Ok(img)
}

fn derive_preview_base(
    proxy: Arc<Rgb16Image>,
    file_kind: crate::asset::format::FileKind,
    requested_max_edge: Option<u32>,
) -> Result<Arc<Rgb16Image>> {
    let requested = match file_kind {
        crate::asset::format::FileKind::Raw => requested_max_edge,
        _ => return Ok(proxy),
    };
    let mut img = resize_to_max_edge((*proxy).clone(), requested)?;
    crate::processing::raw::apply_app_baseline_tone(&mut img);
    Ok(Arc::new(img))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset::format::FileKind;
    use image::{ImageBuffer, Rgb};

    #[test]
    fn raw_preview_base_uses_authority_proxy_cache_edge() {
        assert_eq!(
            preview_base_cache_max_edge(FileKind::Raw, Some(INTERACTIVE_TEST_EDGE)),
            Some(RAW_PREVIEW_PROXY_MAX_EDGE)
        );
        assert_eq!(
            preview_base_cache_max_edge(FileKind::Raw, Some(1920)),
            Some(RAW_PREVIEW_PROXY_MAX_EDGE)
        );
        assert_eq!(preview_base_cache_max_edge(FileKind::Raw, None), None);
    }

    #[test]
    fn non_raw_preview_base_keeps_requested_cache_edge() {
        assert_eq!(
            preview_base_cache_max_edge(FileKind::Image, Some(INTERACTIVE_TEST_EDGE)),
            Some(INTERACTIVE_TEST_EDGE)
        );
        assert_eq!(preview_base_cache_max_edge(FileKind::Image, None), None);
    }

    #[test]
    fn raw_preview_base_derives_requested_size_and_applies_baseline_tone() {
        let proxy = Arc::new(ImageBuffer::from_pixel(3000, 1500, Rgb([32_000, 32_000, 32_000])));
        let derived = derive_preview_base(proxy, FileKind::Raw, Some(INTERACTIVE_TEST_EDGE))
            .expect("derive raw preview base");

        assert_eq!(derived.dimensions(), (INTERACTIVE_TEST_EDGE, 480));
        assert_ne!(derived.get_pixel(0, 0).0, [32_000, 32_000, 32_000]);
    }

    #[test]
    fn image_preview_base_reuses_cached_proxy_without_derivation() {
        let proxy = Arc::new(ImageBuffer::from_pixel(3000, 1500, Rgb([32_000, 32_000, 32_000])));
        let derived =
            derive_preview_base(proxy.clone(), FileKind::Image, Some(INTERACTIVE_TEST_EDGE))
                .expect("derive image preview base");

        assert!(Arc::ptr_eq(&derived, &proxy));
    }

    #[test]
    fn raw_full_preview_keeps_native_cache_edge() {
        assert_eq!(preview_base_cache_max_edge(FileKind::Raw, None), None);
    }

    #[test]
    fn white_balance_sampling_uses_bounded_preview_edge() {
        assert_eq!(white_balance_sample_max_edge(), Some(2048));
    }

    #[test]
    fn baseline_disk_cache_key_includes_file_and_size_inputs() {
        let a = baseline_disk_cache_key(
            7,
            std::path::Path::new("/tmp/a.jpg"),
            Some(100),
            Some(1280),
            Some(6000),
        );
        let b = baseline_disk_cache_key(
            7,
            std::path::Path::new("/tmp/a.jpg"),
            Some(101),
            Some(1280),
            Some(6000),
        );
        let c = baseline_disk_cache_key(
            7,
            std::path::Path::new("/tmp/b.jpg"),
            Some(100),
            Some(1280),
            Some(6000),
        );

        assert_ne!(a, b);
        assert_ne!(a, c);
        assert!(a.contains("max=1280"));
        assert!(a.contains("native=6000"));
    }

    #[test]
    fn baseline_disk_cache_path_is_a_jpeg_inside_cache_dir() {
        let path = baseline_disk_cache_path(std::path::Path::new("/cache/baseline"), 7, "key");

        assert_eq!(path.parent(), Some(std::path::Path::new("/cache/baseline")));
        assert_eq!(path.extension().and_then(|v| v.to_str()), Some("jpg"));
        assert!(path.file_name().and_then(|v| v.to_str()).unwrap().starts_with("7_"));
    }

    #[test]
    fn baseline_cache_bytes_result_uses_blob_transport() {
        let result = preview_result_from_baseline_cache_bytes(vec![1, 2, 3], 640, 480);

        assert_eq!(result.path, None);
        assert_eq!(result.data, Some(vec![1, 2, 3]));
        assert_eq!(result.width, 640);
        assert_eq!(result.height, 480);
    }

    const INTERACTIVE_TEST_EDGE: u32 = 960;
}

/// 使用 Gray World 算法计算自动白平衡偏移量。
///
/// 返回 `(wb_shift_r, wb_shift_g, wb_shift_b)`，范围 -100..100（整数）。
#[tauri::command]
pub async fn auto_white_balance(
    state: State<'_, SharedState>,
    asset_id: i64,
    project_id: Option<i64>,
) -> Result<(i32, i32, i32)> {
    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);
    let export_pool = state.export_pool.clone();
    let state_for_sample = state.inner().clone();

    tokio::task::spawn_blocking(move || {
        export_pool.install(|| {
            let img = load_white_balance_image(
                &state_for_sample,
                asset_id,
                asset.is_raw != 0,
                &path,
                asset.width.zip(asset.height).map(|(w, h)| w.max(h).max(1) as u32),
                project_id,
            )?;
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
    project_id: Option<i64>,
) -> Result<(f32, f32, f32)> {
    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);
    let export_pool = state.export_pool.clone();
    let state_for_sample = state.inner().clone();

    tokio::task::spawn_blocking(move || {
        export_pool.install(|| {
            let img = load_white_balance_image(
                &state_for_sample,
                asset_id,
                asset.is_raw != 0,
                &path,
                asset.width.zip(asset.height).map(|(w, h)| w.max(h).max(1) as u32),
                project_id,
            )?;
            let (w, h) = img.dimensions();
            let sample_x = asset
                .width
                .filter(|native_w| *native_w > 0 && *native_w as u32 != w)
                .map(|native_w| ((x as f64 / native_w as f64) * w as f64).round() as u32)
                .unwrap_or(x)
                .min(w.saturating_sub(1));
            let sample_y = asset
                .height
                .filter(|native_h| *native_h > 0 && *native_h as u32 != h)
                .map(|native_h| ((y as f64 / native_h as f64) * h as f64).round() as u32)
                .unwrap_or(y)
                .min(h.saturating_sub(1));
            if sample_x >= w || sample_y >= h {
                return Err(AppError::other(format!(
                    "eyedrop out of bounds: ({x}, {y}) exceeds ({w}, {h})"
                )));
            }
            Ok(processing::white_balance::eyedrop_color(
                &img, sample_x, sample_y,
            ))
        })
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}

fn load_white_balance_image(
    state: &SharedState,
    asset_id: i64,
    is_raw: bool,
    source_path: &std::path::Path,
    native_max_edge: Option<u32>,
    project_id: Option<i64>,
) -> Result<Rgb16Image> {
    if is_raw {
        return load_preview_base(
            state,
            asset_id,
            source_path,
            white_balance_sample_max_edge(),
            native_max_edge,
            project_id,
        )
        .map(|img| (*img).clone());
    }
    processing::load_image_rgb16(source_path)
}

fn white_balance_sample_max_edge() -> Option<u32> {
    Some(WHITE_BALANCE_SAMPLE_MAX_EDGE)
}

//! 独立直方图计算命令。与 get_preview 解耦：
//! - 工作尺寸 512px（256-bin 直方图视觉无差，CPU 砍 14×）
//! - 独立 histogram_token 取消，不与预览互相误杀
//! - 共享 preview_sem 信号量，避免抢 CPU
//! - 不写盘、不编 JPEG，纯计算后立即返回

use crate::db::assets;
use crate::error::{AppError, Result};
use crate::processing::histogram::{self, HistogramData};
use crate::processing::{self, FilterSettings};
use crate::state::SharedState;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn compute_histogram(
    state: State<'_, SharedState>,
    asset_id: i64,
    settings: Option<FilterSettings>,
    token: u64,
) -> Result<HistogramData> {
    use std::sync::atomic::Ordering;

    state.histogram_token.store(token, Ordering::SeqCst);

    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);
    let settings = settings.unwrap_or_default();
    let lut = super::cached_lut(&state, settings.lut_file_path.as_deref())?;
    let export_pool = state.export_pool.clone();
    let sem = state.preview_sem.clone();
    let histogram_token = state.histogram_token.clone();
    let raw_original_dir = state.raw_original_dir.clone();

    let permit = sem
        .acquire_owned()
        .await
        .map_err(|_| AppError::other("preview_busy"))?;

    if histogram_token.load(Ordering::SeqCst) != token {
        return Err(AppError::other("preview_cancelled"));
    }

    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        export_pool.install(|| {
            let cache_path = processing::raw::preview_base_path(&raw_original_dir, asset_id);

            let resized = if cache_path.exists() {
                match crate::vips_io::decode_to_rgb16(&cache_path) {
                    Ok(img) => resize_to_512(img)?,
                    Err(_) => decode_and_resize_512(&path)?,
                }
            } else {
                decode_and_resize_512(&path)?
            };

            if histogram_token.load(Ordering::SeqCst) != token {
                return Err(AppError::other("preview_cancelled"));
            }

            let processed = crate::processing::process_image(&resized, &settings, lut.as_deref())?;
            if histogram_token.load(Ordering::SeqCst) != token {
                return Err(AppError::other("preview_cancelled"));
            }
            Ok(histogram::compute(&processed))
        })
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}

fn resize_to_512(
    src: image::ImageBuffer<image::Rgb<u16>, Vec<u16>>,
) -> Result<image::ImageBuffer<image::Rgb<u16>, Vec<u16>>> {
    let (w, h) = src.dimensions();
    let scale = (512.0_f32 / w.max(h) as f32).min(1.0);
    if scale < 1.0 {
        let nw = (w as f32 * scale).round().max(1.0) as u32;
        let nh = (h as f32 * scale).round().max(1.0) as u32;
        crate::vips_io::resize_rgb16(&src, nw, nh)
    } else {
        Ok(src)
    }
}

fn decode_and_resize_512(
    path: &std::path::Path,
) -> Result<image::ImageBuffer<image::Rgb<u16>, Vec<u16>>> {
    use crate::asset::format::{classify, FileKind};
    let src = match classify(path) {
        FileKind::Raw => processing::raw::decode_raw_rgb16_for_preview(path, Some(512))?,
        _ => processing::load_image_rgb16(path)?,
    };
    resize_to_512(src)
}

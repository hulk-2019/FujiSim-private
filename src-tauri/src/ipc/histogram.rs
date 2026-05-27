//! 独立直方图计算命令。与 get_preview 解耦：
//! - 工作尺寸 512px（256-bin 直方图视觉无差，CPU 砍 14×）
//! - 独立 histogram_token 取消，不与预览互相误杀
//! - 共享 preview_sem 信号量，避免抢 CPU
//! - 不写盘、不编 JPEG，纯计算后立即返回

use crate::db::assets;
use crate::error::{AppError, Result};
use crate::processing::histogram::{self, HistogramData};
use crate::processing::FilterSettings;
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
    let native_max_edge = asset
        .width
        .zip(asset.height)
        .map(|(w, h)| w.max(h).max(1) as u32);
    let settings = settings.unwrap_or_default();
    let lut = super::cached_lut(&state, settings.lut_file_path.as_deref())?;
    let export_pool = state.export_pool.clone();
    let sem = state.preview_sem.clone();
    let histogram_token = state.histogram_token.clone();
    let state_for_render = state.inner().clone();

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
            let resized = super::preview::load_preview_base(
                &state_for_render,
                asset_id,
                &path,
                Some(512),
                native_max_edge,
                false,
            )?;

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

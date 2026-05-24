//! 实时预览渲染和封面缓存目录。

use crate::db::assets;
use crate::error::{AppError, Result};
use crate::processing::{self, FilterSettings};
use crate::state::SharedState;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

/// 预览结果。前端用 convertFileSrc(path) 加载本地文件，零 IPC 传输开销。
#[derive(Debug, Serialize, Clone)]
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
            use crate::asset::format::{classify, FileKind};
            let src = match classify(&path) {
                FileKind::Raw => processing::raw::decode_raw_rgb16_for_preview(&path, max_edge)?,
                _ => processing::load_image_rgb16(&path)?,
            };
            // 解码完成后再检查一次（RAW 解码是最耗时的部分）
            if preview_token.load(Ordering::SeqCst) != token {
                return Err(AppError::other("preview_cancelled"));
            }
            let (w, h) = src.dimensions();
            let resized = if let Some(me) = max_edge {
                let scale = (me as f32 / w.max(h) as f32).min(1.0);
                if scale < 1.0 {
                    let nw = (w as f32 * scale).round().max(1.0) as u32;
                    let nh = (h as f32 * scale).round().max(1.0) as u32;
                    crate::vips_io::resize_rgb16(&src, nw, nh)?
                } else {
                    src
                }
            } else {
                src
            };
            let (rw, rh) = resized.dimensions();
            let processed = crate::processing::process_image(&resized, &settings, lut.as_deref())?;
            let jpeg =
                crate::vips_io::encode_rgb16(&processed, crate::export::ExportFormat::Jpeg, 88)?;
            let out_path =
                std::env::temp_dir().join(format!("fujisim_preview_{asset_id}_{token}.jpg"));
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

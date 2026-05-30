//! 应用级杂项：清缓存、重置数据、内置富士模拟列表。

use crate::db::{user_fonts, watermark_svgs};
use crate::error::Result;
use crate::processing;
use crate::state::SharedState;
use tauri::State;

#[tauri::command]
pub async fn list_fuji_simulations() -> Result<Vec<String>> {
    Ok(processing::fuji::BUILTIN_NAMES
        .iter()
        .map(|s| s.to_string())
        .collect())
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
    if let Ok(mut cache) = state.preview_base_cache.lock() {
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

/// 清空所有业务表数据（保留表结构）。用于"清除缓存"功能。
/// 同时清空内存中的 LUT 缓存。
#[tauri::command]
pub async fn clear_all_data(state: State<'_, SharedState>) -> Result<()> {
    crate::db::tasks::clear_all(&state.pool).await?;
    if let Ok(mut cache) = state.lut_cache.lock() {
        cache.clear();
    }
    if let Ok(mut cache) = state.preview_base_cache.lock() {
        cache.clear();
    }
    // watermarks 目录整体清空
    if state.watermark_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.watermark_dir);
        let _ = std::fs::create_dir_all(&state.watermark_dir);
    }
    // 导入的 SVG 水印整体清空
    watermark_svgs::delete_all(&state.pool).await?;
    if state.watermark_svg_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.watermark_svg_dir);
        let _ = std::fs::create_dir_all(&state.watermark_svg_dir);
    }
    // 项目封面缓存整体清空
    if state.project_cover_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.project_cover_dir);
        let _ = std::fs::create_dir_all(&state.project_cover_dir);
    }
    // baseline 权威预览磁盘缓存整体清空
    crate::db::asset_render_cache::delete_kind(&state.pool, "preview_baseline").await?;
    if state.preview_baseline_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.preview_baseline_dir);
        let _ = std::fs::create_dir_all(&state.preview_baseline_dir);
    }
    // 软删除所有字体记录，清空 fonts 目录
    user_fonts::delete_all(&state.pool).await?;
    if state.font_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.font_dir);
        let _ = std::fs::create_dir_all(&state.font_dir);
    }
    Ok(())
}

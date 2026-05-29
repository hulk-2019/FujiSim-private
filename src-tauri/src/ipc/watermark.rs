//! 水印预设与导入 SVG 水印 CRUD。

use crate::db::{watermark_presets, watermark_svgs};
use crate::error::Result;
use crate::export::watermark_svg::sanitize_svg;
use crate::state::SharedState;
use std::path::PathBuf;
use tauri::State;

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

#[tauri::command]
pub async fn list_watermark_svgs(
    state: State<'_, SharedState>,
) -> Result<Vec<watermark_svgs::UserWatermarkSvg>> {
    watermark_svgs::list(&state.pool).await
}

#[tauri::command]
pub async fn import_watermark_svgs(
    state: State<'_, SharedState>,
    paths: Vec<String>,
) -> Result<Vec<watermark_svgs::UserWatermarkSvg>> {
    let mut out = Vec::new();
    for src in paths {
        let src_path = PathBuf::from(&src);
        if src_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("svg"))
            != Some(true)
        {
            continue;
        }
        let raw = std::fs::read_to_string(&src_path)?;
        let sanitized = sanitize_svg(&raw)?;
        let stem = src_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("watermark");
        let dest = state.watermark_svg_dir.join(format!("{stem}.svg"));
        std::fs::write(&dest, &sanitized)?;
        let dest_str = dest.to_string_lossy().to_string();
        out.push(watermark_svgs::insert(&state.pool, stem, &dest_str, Some(&sanitized)).await?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn delete_watermark_svg(state: State<'_, SharedState>, id: i64) -> Result<()> {
    if let Some(path) = watermark_svgs::delete(&state.pool, id).await? {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

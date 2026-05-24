//! 水印预设 CRUD。

use crate::db::watermark_presets;
use crate::error::Result;
use crate::state::SharedState;
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

//! 滤镜预设和分类管理。

use crate::db::{preset_categories, presets, user_luts};
use crate::error::{AppError, Result};
use crate::state::SharedState;
use tauri::State;

#[tauri::command]
pub async fn list_presets(state: State<'_, SharedState>) -> Result<Vec<presets::FilterPreset>> {
    presets::list(&state.pool).await
}

#[tauri::command]
pub async fn save_preset(
    state: State<'_, SharedState>,
    preset: presets::NewFilterPreset,
) -> Result<presets::FilterPreset> {
    presets::upsert(&state.pool, &preset).await
}

#[tauri::command]
pub async fn delete_preset(state: State<'_, SharedState>, id: i64) -> Result<()> {
    presets::delete(&state.pool, id).await
}

// ===== 预设分类 =====

#[tauri::command]
pub async fn list_preset_categories(
    state: State<'_, SharedState>,
) -> Result<Vec<preset_categories::PresetCategory>> {
    preset_categories::list(&state.pool).await
}

#[tauri::command]
pub async fn create_preset_category(
    state: State<'_, SharedState>,
    name: String,
) -> Result<preset_categories::PresetCategory> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::other("分类名不能为空"));
    }
    preset_categories::create(&state.pool, trimmed).await
}

#[tauri::command]
pub async fn rename_preset_category(
    state: State<'_, SharedState>,
    id: i64,
    name: String,
) -> Result<preset_categories::PresetCategory> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::other("分类名不能为空"));
    }
    preset_categories::rename(&state.pool, id, trimmed).await
}

#[tauri::command]
pub async fn delete_preset_category(state: State<'_, SharedState>, id: i64) -> Result<()> {
    preset_categories::delete(&state.pool, id).await
}

#[tauri::command]
pub async fn check_preset_category_name_exists(
    state: State<'_, SharedState>,
    name: String,
    exclude_id: Option<i64>,
) -> Result<bool> {
    preset_categories::name_exists(&state.pool, name.trim(), exclude_id).await
}

#[tauri::command]
pub async fn set_preset_category(
    state: State<'_, SharedState>,
    preset_id: i64,
    category_id: Option<i64>,
) -> Result<()> {
    presets::set_category(&state.pool, preset_id, category_id).await
}

#[tauri::command]
pub async fn set_user_lut_category(
    state: State<'_, SharedState>,
    lut_id: i64,
    category_id: Option<i64>,
) -> Result<()> {
    user_luts::set_category(&state.pool, lut_id, category_id).await
}

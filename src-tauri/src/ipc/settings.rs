//! 应用设置 KV 存储。
//!
//! 设置以 `(key, value)` 形式落库，复杂类型由前端 JSON 序列化后再传入。

use crate::error::Result;
use crate::state::SharedState;
use tauri::State;

/// 取单个设置值，未设置时返回 `None`。
#[tauri::command]
pub async fn get_setting(state: State<'_, SharedState>, key: String) -> Result<Option<String>> {
    crate::db::app_settings::get(&state.pool, &key).await
}

/// 写入或更新设置值。复杂类型由前端 `JSON.stringify` 后再传入。
#[tauri::command]
pub async fn set_setting(state: State<'_, SharedState>, key: String, value: String) -> Result<()> {
    crate::db::app_settings::set(&state.pool, &key, &value).await
}

/// 删除某项设置。删除不存在的 key 不视为错误。
#[tauri::command]
pub async fn delete_setting(state: State<'_, SharedState>, key: String) -> Result<()> {
    crate::db::app_settings::delete(&state.pool, &key).await
}

/// 一次性获取所有设置项。前端启动时调用，避免发起 N 次 IPC。
#[tauri::command]
pub async fn get_all_settings(
    state: State<'_, SharedState>,
) -> Result<std::collections::HashMap<String, String>> {
    crate::db::app_settings::get_all(&state.pool).await
}

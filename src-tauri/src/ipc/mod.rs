//! Tauri IPC 命令层。这里的每个 `#[tauri::command]` 都暴露给前端 JS 一一对应调用。
//!
//! 约定：
//! - 函数签名第一个参数是 `State<'_, SharedState>`，用于注入共享状态；
//! - 返回 `Result<T, AppError>`，错误会被序列化为字符串传回 JS 端的 `catch`；
//! - 长任务（导入、批量导出、预览渲染）一律放到 `tokio::task::spawn_blocking` 或
//!   `rayon` 里，不阻塞 Tauri 主事件循环。
//!
//! 命名上和前端 `src/api.ts` 中的方法名严格对齐（snake_case ↔ camelCase 由 Tauri 自动转换）。
//!
//! 模块按业务域拆分，对外通过 `pub use` 重新导出，保持
//! `crate::ipc::<command>` 命名空间不变。

use crate::error::Result;
use crate::processing::lut::Lut3D;
use crate::state::SharedState;
use std::path::Path;
use std::sync::Arc;

pub mod projects;
pub mod app;
pub mod assets;
pub mod export;
pub mod fonts;
pub mod histogram;
pub mod luts;
pub mod presets;
pub mod preview;
pub mod settings;
pub mod watermark;

pub use projects::*;
pub use app::*;
pub use assets::*;
pub use export::*;
pub use fonts::*;
pub use histogram::*;
pub use luts::*;
pub use presets::*;
pub use preview::*;
pub use settings::*;
pub use watermark::*;

/// 从 `state.lut_cache` 取出指定路径的 LUT；不存在时加载并缓存。
///
/// 解析失败会向上传播错误。空路径直接返回 `Ok(None)`，调用方据此跳过 LUT 步骤。
fn cached_lut(state: &SharedState, path: Option<&Path>) -> Result<Option<Arc<Lut3D>>> {
    let path = match path {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => return Ok(None),
    };
    let key = path.to_path_buf();
    {
        let cache = state.lut_cache.lock().expect("lut_cache poisoned");
        if let Some(lut) = cache.get(&key) {
            return Ok(Some(lut.clone()));
        }
    }
    let lut = Arc::new(Lut3D::load_cube(path)?);
    let mut cache = state.lut_cache.lock().expect("lut_cache poisoned");
    Ok(Some(cache.entry(key).or_insert(lut).clone()))
}

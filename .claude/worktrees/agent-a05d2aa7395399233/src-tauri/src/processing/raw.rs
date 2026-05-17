use crate::error::{AppError, Result};
use image::{ImageBuffer, Rgb};
use std::path::Path;

/// RAW 解码占位接口。
///
/// **MVP 阶段**：直接返回 `Unsupported`。UI 检测到 `is_raw=1` 的资产时会显示
/// "RAW 预览暂未启用" 的友好提示，并跳过预览渲染。
///
/// **接入步骤**（未来）：
/// 1. `brew install libraw`（macOS）/ apt-get install libraw-dev（Linux）；
/// 2. 在 [`src-tauri/Cargo.toml`](../../Cargo.toml) 加入 `libraw-rs = "0.0.4"`（或 `rawloader`）；
/// 3. 替换本函数：调用 LibRaw 解码 → 应用相机白平衡 → 返回 16-bit linear RGB；
/// 4. [`crate::processing::pipeline::process_image`] 自动接管后续色彩流水线，
///    调用方零修改。
pub fn decode_raw_rgb16(path: &Path) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    Err(AppError::Unsupported(format!(
        "RAW decoding not yet wired (MVP). Plug libraw-rs here. File: {}",
        path.display()
    )))
}

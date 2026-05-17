//! 色彩流水线模块。
//!
//! 设计思路：
//! - **解码** → 通过 `load_image_rgb16` 统一拿到 16-bit linear RGB；
//! - **处理** → [`pipeline::process_image`] 完成胶片模拟、颗粒、LUT；
//! - **导出** → 由 `crate::export` 负责降到 8-bit 编码到指定格式。
//!
//! 模块划分：
//! - [`color`]：基础颜色数学（HSL 转换、归一化、Saturation/WB Shift）
//! - [`curves`]：色调曲线 LUT
//! - [`fuji`]：13 个内置富士预设的"配方"
//! - [`grain`]：胶片颗粒合成
//! - [`lut`]：3D LUT (`.cube`) 加载与三线性插值
//! - [`pipeline`]：把上述组件组装起来的主流程
//! - [`raw`]：RAW 解码的占位接口（MVP 阶段尚未启用）

use crate::error::Result;
use image::{ImageBuffer, Rgb};
use std::path::Path;

pub mod color;
pub mod curves;
pub mod fuji;
pub mod grain;
pub mod lut;
pub mod pipeline;
pub mod raw;

pub use pipeline::{process_image, FilterSettings};

/// 加载图片到 16-bit linear RGB。
///
/// - 普通图片走 `image::open`，一步到位；
/// - RAW 文件转发到 [`raw::decode_raw_rgb16`]（MVP 阶段返回 `Unsupported`）；
/// - 不支持的扩展名返回 `Unsupported` 错误。
pub fn load_image_rgb16(path: &Path) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    use crate::asset::format::{classify, FileKind};
    match classify(path) {
        FileKind::Image => {
            let img = image::open(path)?;
            Ok(img.to_rgb16())
        }
        FileKind::Raw => raw::decode_raw_rgb16(path),
        FileKind::Unsupported => Err(crate::error::AppError::Unsupported(
            path.display().to_string(),
        )),
    }
}

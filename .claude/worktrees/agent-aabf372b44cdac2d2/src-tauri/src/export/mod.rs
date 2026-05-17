//! 批量导出模块：把"色彩流水线 + 用户导出配置"组合成一张可落盘的图片。
//!
//! 设计要点：
//! - **全分辨率处理**：不像预览那样先缩放，保证导出图色彩计算精度最大化；
//! - **Resize 在最后**：只有 `ExportSettings::resize` 显式要求时才下采样，使用 Lanczos3 内核保边；
//! - **同名安全**：输出文件已存在时自动追加 `_1` `_2` 后缀，**绝不覆盖**用户文件。

use crate::error::{AppError, Result};
use crate::processing::{self, lut::Lut3D, FilterSettings};
use image::{ImageBuffer, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 导出参数。前端 [`ExportSettings`](../../../src/types.ts) 类型与此字段一一对应。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSettings {
    pub format: ExportFormat,
    pub quality: u8,
    pub destination: Destination,
    pub resize: Option<ResizeSpec>,
    pub strip_gps: bool,
    pub filename_template: Option<String>,
}

/// 支持的输出格式。HEIF 暂未列入：image crate 写 HEIF 需要 libheif，
/// 跨平台打包复杂度较高，先支持四个最常用的。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Jpeg,
    Png,
    Tiff,
    Webp,
}

/// 输出目录：可以放在原文件旁的子文件夹（默认 `FujiSim_Export`），
/// 也可以指定一个绝对路径（批量导出到统一仓库）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Destination {
    Subfolder { name: String },
    Path { path: PathBuf },
}

/// 缩放规格。LongEdge 是常见的"按最长边缩到 N 像素"，Percent 是简单百分比。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResizeSpec {
    LongEdge(u32),
    Percent(u32),
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            format: ExportFormat::Jpeg,
            quality: 92,
            destination: Destination::Subfolder {
                name: "FujiSim_Export".into(),
            },
            resize: None,
            strip_gps: false,
            filename_template: None,
        }
    }
}

/// 把 `Destination` 解析成具体的目录路径，必要时创建该目录。
pub fn resolve_destination_dir(src: &Path, dest: &Destination) -> Result<PathBuf> {
    let dir = match dest {
        Destination::Subfolder { name } => {
            let parent = src.parent().ok_or_else(|| AppError::other("no parent"))?;
            parent.join(name)
        }
        Destination::Path { path } => path.clone(),
    };
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 导出单张图片到 `out_dir`。
///
/// 流程：解码 → 色彩流水线（全分辨率）→ Resize（可选）→ 16-bit 转 8-bit → 编码落盘。
/// 文件名规则：`<原名>_<胶片预设名>.<ext>`，同名时追加 `_1` `_2` 后缀。
///
/// `lut` 由调用方传入（可为 `None`），避免在批量导出时每张图都重新读盘解析。
pub fn export_one(
    src_path: &Path,
    out_dir: &Path,
    filter: &FilterSettings,
    export: &ExportSettings,
    lut: Option<&Lut3D>,
) -> Result<PathBuf> {
    let src = processing::load_image_rgb16(src_path)?;
    let processed = processing::process_image(&src, filter, lut)?;
    let final_image = match &export.resize {
        Some(ResizeSpec::LongEdge(le)) => {
            let (w, h) = processed.dimensions();
            let scale = (*le as f32) / (w.max(h) as f32);
            if scale >= 1.0 {
                processed
            } else {
                let nw = (w as f32 * scale).round() as u32;
                let nh = (h as f32 * scale).round() as u32;
                image::imageops::resize(&processed, nw, nh, image::imageops::FilterType::Lanczos3)
            }
        }
        Some(ResizeSpec::Percent(p)) => {
            let (w, h) = processed.dimensions();
            let s = (*p as f32) / 100.0;
            let nw = (w as f32 * s).round().max(1.0) as u32;
            let nh = (h as f32 * s).round().max(1.0) as u32;
            image::imageops::resize(&processed, nw, nh, image::imageops::FilterType::Lanczos3)
        }
        None => processed,
    };

    let mut rgb8: RgbImage = ImageBuffer::new(final_image.width(), final_image.height());
    for (x, y, px) in final_image.enumerate_pixels() {
        rgb8.put_pixel(
            x,
            y,
            Rgb([(px.0[0] >> 8) as u8, (px.0[1] >> 8) as u8, (px.0[2] >> 8) as u8]),
        );
    }

    let stem = src_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    let ext = match export.format {
        ExportFormat::Jpeg => "jpg",
        ExportFormat::Png => "png",
        ExportFormat::Tiff => "tif",
        ExportFormat::Webp => "webp",
    };
    let suffix = format!("_{}", sanitize(&filter.base_simulation));
    let mut out = out_dir.join(format!("{stem}{suffix}.{ext}"));
    let mut i = 1;
    while out.exists() {
        out = out_dir.join(format!("{stem}{suffix}_{i}.{ext}"));
        i += 1;
    }

    match export.format {
        ExportFormat::Jpeg => {
            let mut writer = std::fs::File::create(&out)?;
            let encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, export.quality);
            rgb8.write_with_encoder(encoder)?;
        }
        ExportFormat::Png => rgb8.save_with_format(&out, image::ImageFormat::Png)?,
        ExportFormat::Tiff => rgb8.save_with_format(&out, image::ImageFormat::Tiff)?,
        ExportFormat::Webp => rgb8.save_with_format(&out, image::ImageFormat::WebP)?,
    }
    Ok(out)
}

/// 文件名清理：把非 ASCII 字母数字字符替换为下划线，避免预设名里的空格/标点污染文件名。
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

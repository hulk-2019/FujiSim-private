//! 批量导出模块：把"色彩流水线 + 用户导出配置"组合成一张可落盘的图片。

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

/// 前端 Canvas 渲染好的水印层，base64 PNG + 原始尺寸 + 全局不透明度乘数。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatermarkLayer {
    /// base64 编码的 PNG（不含 data: 前缀）
    pub data: String,
    /// 渲染水印时预览图的宽度（用于等比缩放到导出尺寸）
    pub width: u32,
    /// 渲染水印时预览图的高度
    pub height: u32,
    /// 全局不透明度（0-1），与 PNG 像素 alpha 相乘
    pub opacity: f32,
}

/// 支持的输出格式。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Jpeg,
    Png,
    Tiff,
    Webp,
    Gif,
    Bmp,
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

/// 从磁盘读取水印 PNG，按各轴独立缩放到输出图尺寸后合成。
/// 独立缩放（而非等比+居中）保证位置语义正确：bottom-center 始终在底部中央，
/// 即使水印 canvas 与输出图宽高比不同也不会偏移。
fn load_watermark_from_file(path: &Path, out_w: u32, out_h: u32) -> Result<image::RgbaImage> {
    let wm_img = image::open(path)
        .map_err(|e| AppError::other(format!("watermark open: {e}")))?
        .into_rgba8();

    let (wm_w, wm_h) = wm_img.dimensions();
    if (wm_w, wm_h) == (out_w, out_h) {
        return Ok(wm_img);
    }
    Ok(image::imageops::resize(
        &wm_img,
        out_w,
        out_h,
        image::imageops::FilterType::Lanczos3,
    ))
}

fn composite_watermark(base: &mut RgbImage, overlay: &image::RgbaImage) {
    let (out_w, out_h) = base.dimensions();
    for (x, y, ov) in overlay.enumerate_pixels() {
        let alpha = ov[3] as f32 / 255.0;
        if alpha < 0.001 {
            continue;
        }
        if x < out_w && y < out_h {
            let bg = base.get_pixel_mut(x, y);
            bg[0] = (ov[0] as f32 * alpha + bg[0] as f32 * (1.0 - alpha)).round() as u8;
            bg[1] = (ov[1] as f32 * alpha + bg[1] as f32 * (1.0 - alpha)).round() as u8;
            bg[2] = (ov[2] as f32 * alpha + bg[2] as f32 * (1.0 - alpha)).round() as u8;
        }
    }
}

/// 导出单张图片到 `out_dir`。`watermark_path` 指向预先保存的水印 PNG 文件。
pub fn export_one(
    src_path: &Path,
    out_dir: &Path,
    filter: &FilterSettings,
    export: &ExportSettings,
    lut: Option<&Lut3D>,
    watermark_path: Option<&Path>,
) -> Result<PathBuf> {
    let src = processing::load_image_rgb16(src_path)?;
    let processed = processing::process_image(&src, filter, lut)?;
    // src 已不再需要，立即释放（6000×4000 RAW 约 144MB）
    drop(src);

    let final_image = match &export.resize {
        Some(ResizeSpec::LongEdge(le)) => {
            let (w, h) = processed.dimensions();
            let scale = (*le as f32) / (w.max(h) as f32);
            if scale >= 1.0 {
                processed
            } else {
                let nw = (w as f32 * scale).round() as u32;
                let nh = (h as f32 * scale).round() as u32;
                let resized = image::imageops::resize(&processed, nw, nh, image::imageops::FilterType::Lanczos3);
                // processed 已不再需要，立即释放（约 144MB）
                drop(processed);
                resized
            }
        }
        Some(ResizeSpec::Percent(p)) => {
            let (w, h) = processed.dimensions();
            let s = (*p as f32) / 100.0;
            let nw = (w as f32 * s).round().max(1.0) as u32;
            let nh = (h as f32 * s).round().max(1.0) as u32;
            let resized = image::imageops::resize(&processed, nw, nh, image::imageops::FilterType::Lanczos3);
            drop(processed);
            resized
        }
        None => processed,
    };

    let out_w = final_image.width();
    let out_h = final_image.height();
    let mut rgb8: RgbImage = ImageBuffer::new(out_w, out_h);
    for (x, y, px) in final_image.enumerate_pixels() {
        rgb8.put_pixel(
            x,
            y,
            Rgb([(px.0[0] >> 8) as u8, (px.0[1] >> 8) as u8, (px.0[2] >> 8) as u8]),
        );
    }

    // 合成水印：从磁盘读取预渲染的 PNG，按输出尺寸独立缩放后合成
    if let Some(wm_path) = watermark_path {
        match load_watermark_from_file(wm_path, out_w, out_h) {
            Ok(overlay) => composite_watermark(&mut rgb8, &overlay),
            Err(e) => tracing::warn!("watermark composite skipped: {e}"),
        }
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
        ExportFormat::Gif => "gif",
        ExportFormat::Bmp => "bmp",
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
        ExportFormat::Webp => {
            let mut writer = std::fs::File::create(&out)?;
            let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut writer);
            rgb8.write_with_encoder(encoder)?;
        }
        ExportFormat::Gif => rgb8.save_with_format(&out, image::ImageFormat::Gif)?,
        ExportFormat::Bmp => rgb8.save_with_format(&out, image::ImageFormat::Bmp)?,
    }
    Ok(out)
}

/// 文件名清理：把非 ASCII 字母数字字符替换为下划线。
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}


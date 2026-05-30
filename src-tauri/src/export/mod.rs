//! 批量导出模块：把"色彩流水线 + 用户导出配置"组合成一张可落盘的图片。

use crate::error::{AppError, Result};
use crate::processing::{self, lut::Lut3D, FilterSettings};
use image::{ImageBuffer, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub mod watermark_svg;

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

/// 输出目录：可以放在原文件旁的子文件夹（默认 `FotoForge_Export`），
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
                name: "FotoForge_Export".into(),
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

/// 导出单张图片到 `out_dir`。水印由持久化的 SVG 设置在最终尺寸上渲染。
pub fn export_one(
    src_path: &Path,
    out_dir: &Path,
    filter: &FilterSettings,
    export: &ExportSettings,
    lut: Option<&Lut3D>,
    watermark_settings: Option<&serde_json::Value>,
    watermark_layer_path: Option<&str>,
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
                let resized = crate::vips_io::resize_rgb16(&processed, nw, nh)?;
                drop(processed);
                resized
            }
        }
        Some(ResizeSpec::Percent(p)) => {
            let (w, h) = processed.dimensions();
            let s = (*p as f32) / 100.0;
            let nw = (w as f32 * s).round().max(1.0) as u32;
            let nh = (h as f32 * s).round().max(1.0) as u32;
            let resized = crate::vips_io::resize_rgb16(&processed, nw, nh)?;
            drop(processed);
            resized
        }
        None => processed,
    };

    let out_w = final_image.width();
    let out_h = final_image.height();

    let final_image = match load_watermark_overlay(watermark_layer_path, watermark_settings, out_w, out_h) {
        Some(overlay) => {
            let mut rgb8 = to_rgb8(&final_image);
            composite_watermark(&mut rgb8, &overlay);
            let pixels: Vec<u16> = rgb8
                .pixels()
                .flat_map(|p| {
                    [
                        p.0[0] as u16 * 257,
                        p.0[1] as u16 * 257,
                        p.0[2] as u16 * 257,
                    ]
                })
                .collect();
            image::ImageBuffer::from_raw(out_w, out_h, pixels).unwrap_or(final_image)
        }
        None => final_image,
    };

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

    crate::vips_io::encode_rgb16_to_file(&final_image, &out, export.format, export.quality)?;
    Ok(out)
}

fn load_watermark_overlay(
    watermark_layer_path: Option<&str>,
    watermark_settings: Option<&serde_json::Value>,
    out_w: u32,
    out_h: u32,
) -> Option<image::RgbaImage> {
    if let Some(path) = watermark_layer_path {
        match image::open(path).map(|img| img.to_rgba8()) {
            Ok(overlay) => return Some(overlay),
            Err(e) => tracing::warn!("png watermark layer load failed: {e}"),
        }
    }

    let wm = watermark_settings?;
    match crate::export::watermark_svg::build_watermark_svg_from_json(wm, out_w, out_h)
        .and_then(|svg| crate::export::watermark_svg::rasterize_svg(&svg, out_w, out_h))
    {
        Ok(overlay) => Some(overlay),
        Err(e) => {
            tracing::warn!("svg watermark composite skipped: {e}");
            None
        }
    }
}

fn to_rgb8(img: &ImageBuffer<Rgb<u16>, Vec<u16>>) -> RgbImage {
    let (w, h) = img.dimensions();
    let mut out = RgbImage::new(w, h);
    for (x, y, px) in img.enumerate_pixels() {
        out.put_pixel(
            x,
            y,
            Rgb([
                (px.0[0] >> 8) as u8,
                (px.0[1] >> 8) as u8,
                (px.0[2] >> 8) as u8,
            ]),
        );
    }
    out
}

/// 文件名清理：把非 ASCII 字母数字字符替换为下划线。
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

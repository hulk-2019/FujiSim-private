use crate::error::{AppError, Result};
use crate::export::ExportFormat;
use image::{ImageBuffer, Rgb, RgbaImage};
use libvips::{ops, VipsApp, VipsImage};
use libvips::ops::{BandFormat, CastOptions, Direction, Angle, JpegsaveBufferOptions,
                   PngsaveBufferOptions, WebpsaveBufferOptions, ResizeOptions, Kernel};
use once_cell::sync::Lazy;
use std::path::Path;

static VIPS: Lazy<VipsApp> = Lazy::new(|| {
    VipsApp::new("FujiSim", false).expect("libvips init failed")
});

pub fn ensure_init() {
    Lazy::force(&VIPS);
}

// ── pixel bridge ─────────────────────────────────────────────────────────────

pub(crate) fn rgb16_to_vips(img: &ImageBuffer<Rgb<u16>, Vec<u16>>) -> Result<VipsImage> {
    let (w, h) = img.dimensions();
    let pixels: &[u16] = img.as_raw();
    let bytes = unsafe {
        std::slice::from_raw_parts(pixels.as_ptr() as *const u8, pixels.len() * 2)
    };
    VipsImage::new_from_memory(bytes, w as i32, h as i32, 3, BandFormat::Ushort)
        .map_err(|e| AppError::Vips(e.to_string()))
}

pub(crate) fn vips_to_rgb16(vimg: &VipsImage) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let w = vimg.get_width() as u32;
    let h = vimg.get_height() as u32;
    let raw = vimg.image_write_to_memory();
    let pixels: Vec<u16> = raw
        .chunks_exact(2)
        .map(|b| u16::from_ne_bytes([b[0], b[1]]))
        .collect();
    ImageBuffer::from_raw(w, h, pixels)
        .ok_or_else(|| AppError::Vips("vips→rgb16 buffer size mismatch".into()))
}

// ── public decode / resize / info ─────────────────────────────────────────────

pub fn decode_to_rgb16(path: &Path) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    ensure_init();
    let path_str = path.to_str()
        .ok_or_else(|| AppError::Vips("non-UTF8 path".into()))?;
    let vimg = VipsImage::new_from_file(path_str)
        .map_err(|e| AppError::Vips(format!("decode {path_str}: {e}")))?;
    let vimg = ops::cast_with_opts(&vimg, BandFormat::Ushort, &CastOptions { shift: true })
        .map_err(|e| AppError::Vips(format!("cast ushort: {e}")))?;
    // strip alpha if present (RGBA → RGB)
    let vimg = if vimg.get_bands() == 4 {
        let r = ops::extract_band(&vimg, 0)
            .map_err(|e| AppError::Vips(format!("strip alpha: {e}")))?;
        let g = ops::extract_band(&vimg, 1)
            .map_err(|e| AppError::Vips(format!("strip alpha: {e}")))?;
        let b = ops::extract_band(&vimg, 2)
            .map_err(|e| AppError::Vips(format!("strip alpha: {e}")))?;
        let mut bands = [r, g, b];
        ops::bandjoin(&mut bands)
            .map_err(|e| AppError::Vips(format!("bandjoin: {e}")))?
    } else {
        vimg
    };
    vips_to_rgb16(&vimg)
}

pub fn decode_bytes_to_rgb16(data: &[u8]) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    // Use image crate to avoid libvips new_from_buffer GObject ABI issue with empty option_str
    let dyn_img = image::load_from_memory(data)
        .map_err(|e| AppError::Vips(format!("decode bytes: {e}")))?;
    let rgb16 = dyn_img.into_rgb16();
    Ok(rgb16)
}

pub fn resize_rgb16(
    img: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    nw: u32,
    nh: u32,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    ensure_init();
    let (w, h) = img.dimensions();
    let vimg = rgb16_to_vips(img)?;
    let hscale = nw as f64 / w as f64;
    let vscale = nh as f64 / h as f64;
    let resized = ops::resize_with_opts(&vimg, hscale, &ResizeOptions {
        kernel: Kernel::Lanczos3,
        vscale,
        ..ResizeOptions::default()
    }).map_err(|e| AppError::Vips(format!("resize: {e}")))?;
    vips_to_rgb16(&resized)
}

pub fn image_dimensions(path: &Path) -> Result<(u32, u32)> {
    ensure_init();
    let path_str = path.to_str()
        .ok_or_else(|| AppError::Vips("non-UTF8 path".into()))?;
    let vimg = VipsImage::new_from_file(path_str)
        .map_err(|e| AppError::Vips(format!("dimensions {path_str}: {e}")))?;
    Ok((vimg.get_width() as u32, vimg.get_height() as u32))
}

// ── encode ────────────────────────────────────────────────────────────────────

pub fn encode_rgb16(
    img: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    format: ExportFormat,
    quality: u8,
) -> Result<Vec<u8>> {
    ensure_init();
    let vimg = rgb16_to_vips(img)?;
    match format {
        ExportFormat::Jpeg => {
            let vimg8 = ops::cast_with_opts(&vimg, BandFormat::Uchar, &CastOptions { shift: true })
                .map_err(|e| AppError::Vips(e.to_string()))?;
            ops::jpegsave_buffer_with_opts(&vimg8, &JpegsaveBufferOptions {
                q: quality as i32,
                optimize_coding: true,
                ..JpegsaveBufferOptions::default()
            }).map_err(|e| AppError::Vips(e.to_string()))
        }
        ExportFormat::Png => {
            ops::pngsave_buffer_with_opts(&vimg, &PngsaveBufferOptions {
                bitdepth: 16,
                compression: 6,
                ..PngsaveBufferOptions::default()
            }).map_err(|e| AppError::Vips(e.to_string()))
        }
        ExportFormat::Webp => {
            let vimg8 = ops::cast_with_opts(&vimg, BandFormat::Uchar, &CastOptions { shift: true })
                .map_err(|e| AppError::Vips(e.to_string()))?;
            ops::webpsave_buffer_with_opts(&vimg8, &WebpsaveBufferOptions {
                q: quality as i32,
                ..WebpsaveBufferOptions::default()
            }).map_err(|e| AppError::Vips(e.to_string()))
        }
        ExportFormat::Tiff => {
            let vimg8 = ops::cast_with_opts(&vimg, BandFormat::Uchar, &CastOptions { shift: true })
                .map_err(|e| AppError::Vips(e.to_string()))?;
            ops::tiffsave_buffer(&vimg8)
                .map_err(|e| AppError::Vips(e.to_string()))
        }
        ExportFormat::Gif => {
            let vimg8 = ops::cast_with_opts(&vimg, BandFormat::Uchar, &CastOptions { shift: true })
                .map_err(|e| AppError::Vips(e.to_string()))?;
            ops::gifsave_buffer(&vimg8)
                .map_err(|e| AppError::Vips(e.to_string()))
        }
        ExportFormat::Bmp => {
            // libvips has no bmpsave — fall back to image crate
            let (w, h) = img.dimensions();
            let mut rgb8 = image::RgbImage::new(w, h);
            for (x, y, px) in img.enumerate_pixels() {
                rgb8.put_pixel(x, y, image::Rgb([
                    (px.0[0] >> 8) as u8,
                    (px.0[1] >> 8) as u8,
                    (px.0[2] >> 8) as u8,
                ]));
            }
            let mut buf = std::io::Cursor::new(Vec::new());
            rgb8.write_to(&mut buf, image::ImageFormat::Bmp)
                .map_err(|e| AppError::Vips(e.to_string()))?;
            Ok(buf.into_inner())
        }
    }
}

pub fn encode_rgb16_to_file(
    img: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    path: &Path,
    format: ExportFormat,
    quality: u8,
) -> Result<()> {
    let bytes = encode_rgb16(img, format, quality)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

pub fn apply_jpeg_orientation(jpeg: Vec<u8>, orientation: u32) -> Result<Vec<u8>> {
    if orientation == 1 {
        return Ok(jpeg);
    }
    ensure_init();
    // Decode via image crate to avoid new_from_buffer GObject ABI issue
    let rgb16 = decode_bytes_to_rgb16(&jpeg)?;
    let vimg = rgb16_to_vips(&rgb16)?;
    let rotated = match orientation {
        2 => ops::flip(&vimg, Direction::Horizontal),
        3 => ops::rot(&vimg, Angle::D180),
        4 => ops::flip(&vimg, Direction::Vertical),
        5 => ops::rot(&vimg, Angle::D90)
                .and_then(|r| ops::flip(&r, Direction::Horizontal)),
        6 => ops::rot(&vimg, Angle::D90),
        7 => ops::rot(&vimg, Angle::D270)
                .and_then(|r| ops::flip(&r, Direction::Horizontal)),
        8 => ops::rot(&vimg, Angle::D270),
        _ => return Ok(jpeg),
    }.map_err(|e| AppError::Vips(format!("orient transform: {e}")))?;
    let vimg8 = ops::cast_with_opts(&rotated, BandFormat::Uchar, &CastOptions { shift: true })
        .map_err(|e| AppError::Vips(e.to_string()))?;
    ops::jpegsave_buffer_with_opts(&vimg8, &JpegsaveBufferOptions {
        q: 90,
        ..JpegsaveBufferOptions::default()
    }).map_err(|e| AppError::Vips(e.to_string()))
}

pub fn load_watermark(path: &Path, out_w: u32, out_h: u32) -> Result<RgbaImage> {
    ensure_init();
    let path_str = path.to_str()
        .ok_or_else(|| AppError::Vips("non-UTF8 path".into()))?;
    let vimg = VipsImage::new_from_file(path_str)
        .map_err(|e| AppError::Vips(format!("watermark open: {e}")))?;
    let (wm_w, wm_h) = (vimg.get_width() as u32, vimg.get_height() as u32);
    let vimg = if (wm_w, wm_h) != (out_w, out_h) {
        let hscale = out_w as f64 / wm_w as f64;
        let vscale = out_h as f64 / wm_h as f64;
        ops::resize_with_opts(&vimg, hscale, &ResizeOptions {
            kernel: Kernel::Lanczos3,
            vscale,
            ..ResizeOptions::default()
        }).map_err(|e| AppError::Vips(format!("watermark resize: {e}")))?
    } else {
        vimg
    };
    let vimg = if vimg.get_bands() == 3 {
        ops::bandjoin_const(&vimg, &mut [255.0_f64])
            .map_err(|e| AppError::Vips(e.to_string()))?
    } else {
        vimg
    };
    let raw = vimg.image_write_to_memory();
    RgbaImage::from_raw(out_w, out_h, raw)
        .ok_or_else(|| AppError::Vips("watermark buffer mismatch".into()))
}

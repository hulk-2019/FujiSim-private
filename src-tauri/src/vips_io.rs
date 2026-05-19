use crate::error::{AppError, Result};
use crate::export::ExportFormat;
use image::{ImageBuffer, Rgb, RgbaImage};
use libvips::{ops, VipsApp, VipsImage};
use libvips::ops::{BandFormat, Direction, Angle, JpegsaveOptions, PngsaveOptions,
                   WebpsaveOptions, TiffsaveOptions, ResizeOptions, Kernel};
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

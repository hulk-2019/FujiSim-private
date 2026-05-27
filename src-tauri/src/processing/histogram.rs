//! 处理后图像的 R/G/B/Luminance 直方图计算。

use image::{ImageBuffer, Rgb};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct HistogramData {
    pub r: Vec<u32>,
    pub g: Vec<u32>,
    pub b: Vec<u32>,
    pub luma: Vec<u32>,
}

/// 从 16-bit RGB 图像计算 256-bin 直方图。
///
/// R/G/B 各通道将 u16 值右移 8 位映射到 0-255 bin。
/// Luminance 使用 Rec.709 系数计算后映射到 0-255 bin。
pub fn compute(img: &ImageBuffer<Rgb<u16>, Vec<u16>>) -> HistogramData {
    let mut r = vec![0u32; 256];
    let mut g = vec![0u32; 256];
    let mut b = vec![0u32; 256];
    let mut luma = vec![0u32; 256];

    for pixel in img.pixels() {
        let Rgb([rv, gv, bv]) = *pixel;
        let ri = (rv >> 8) as usize;
        let gi = (gv >> 8) as usize;
        let bi = (bv >> 8) as usize;
        r[ri] += 1;
        g[gi] += 1;
        b[bi] += 1;

        let luma_f = 0.2126 * rv as f32 + 0.7152 * gv as f32 + 0.0722 * bv as f32;
        let li = ((luma_f / 65535.0) * 255.0).round() as usize;
        let li = li.min(255);
        luma[li] += 1;
    }

    HistogramData { r, g, b, luma }
}

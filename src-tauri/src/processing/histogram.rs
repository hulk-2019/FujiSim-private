//! 处理后图像的 R/G/B/Luminance 直方图计算。

use image::{ImageBuffer, Rgb};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistogramData {
    pub r: Vec<u32>,
    pub g: Vec<u32>,
    pub b: Vec<u32>,
    pub luma: Vec<u32>,
    pub total_pixels: u32,
}

/// 从 16-bit RGB 图像计算 256-bin 直方图。
///
/// R/G/B 各通道将 u16 值右移 8 位映射到 0-255 bin。
/// Luminance 使用 Rec.709 系数计算后映射到 0-255 bin。
/// total_pixels 用于前端计算高光/阴影裁剪百分比。
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

    let (w, h) = img.dimensions();
    HistogramData {
        r,
        g,
        b,
        luma,
        total_pixels: w * h,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageBuffer;

    #[test]
    fn compute_counts_pixels_per_bin() {
        // 4 pixels:
        // x=0 black     => R=0,   G=0,   B=0
        // x=1 white     => R=255, G=255, B=255
        // x=2 red mid   => R=128, G=0,   B=0
        // x=3 green mid => R=0,   G=128, B=0
        let img: ImageBuffer<Rgb<u16>, Vec<u16>> = ImageBuffer::from_fn(4, 1, |x, _| match x {
            0 => Rgb([0, 0, 0]),
            1 => Rgb([65535, 65535, 65535]),
            2 => Rgb([32768, 0, 0]),
            _ => Rgb([0, 32768, 0]),
        });
        let h = compute(&img);

        assert_eq!(h.total_pixels, 4);

        // R: 0,255,128,0 => bin 0:2, 128:1, 255:1
        assert_eq!(h.r[0], 2);
        assert_eq!(h.r[128], 1);
        assert_eq!(h.r[255], 1);

        // G: 0,255,0,128 => bin 0:2, 128:1, 255:1
        assert_eq!(h.g[0], 2);
        assert_eq!(h.g[128], 1);
        assert_eq!(h.g[255], 1);

        // B: 0,255,0,0 => bin 0:3, 255:1
        assert_eq!(h.b[0], 3);
        assert_eq!(h.b[255], 1);

        // luma: black -> bin 0, white -> bin 255
        assert_eq!(h.luma[0], 1);
        assert_eq!(h.luma[255], 1);
    }

    #[test]
    fn compute_total_pixels_matches_dimensions() {
        let img: ImageBuffer<Rgb<u16>, Vec<u16>> =
            ImageBuffer::from_pixel(7, 5, Rgb([100, 200, 300]));
        let h = compute(&img);
        assert_eq!(h.total_pixels, 35);
    }
}

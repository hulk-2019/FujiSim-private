//! 白平衡工具：自动白平衡（Gray World）与取色器。

use image::{ImageBuffer, Rgb};

/// 使用 Gray World 算法计算自动白平衡。
///
/// 返回 `(wb_shift_r, wb_shift_b)`，范围 -100..100。
pub fn auto_white_balance(img: &ImageBuffer<Rgb<u16>, Vec<u16>>) -> (f32, f32) {
    let (width, height) = img.dimensions();
    let total_pixels = width as f64 * height as f64;

    let mut sum_r: f64 = 0.0;
    let mut sum_g: f64 = 0.0;
    let mut sum_b: f64 = 0.0;

    for pixel in img.pixels() {
        let Rgb([r, g, b]) = pixel;
        sum_r += f64::from(*r);
        sum_g += f64::from(*g);
        sum_b += f64::from(*b);
    }

    let avg_r = sum_r / total_pixels;
    let avg_g = sum_g / total_pixels;
    let avg_b = sum_b / total_pixels;

    if avg_g == 0.0 {
        return (0.0, 0.0);
    }

    let wb_shift_r = ((avg_g - avg_r) / avg_g * 100.0).clamp(-100.0, 100.0) as f32;
    let wb_shift_b = ((avg_g - avg_b) / avg_g * 100.0).clamp(-100.0, 100.0) as f32;

    (wb_shift_r, wb_shift_b)
}

/// 从图像的 (x, y) 位置采样单个像素的 RGB 值。
///
/// 返回 `(R, G, B)`，范围 0..65535（16-bit）。
pub fn eyedrop_color(img: &ImageBuffer<Rgb<u16>, Vec<u16>>, x: u32, y: u32) -> (f32, f32, f32) {
    let pixel = img.get_pixel(x, y);
    let Rgb([r, g, b]) = pixel;
    (f32::from(*r), f32::from(*g), f32::from(*b))
}

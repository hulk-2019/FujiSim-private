//! 白平衡工具：自动白平衡（Gray World）与取色器。

use image::{ImageBuffer, Rgb};

/// Gray World 自动白平衡。
///
/// 计算整幅图的 R/G/B 均值，然后求解令三通道均值相等的 wb_shift_r/g/b。
/// 增益公式：channel * (1 + shift * 0.005) = avg，所以 shift = (avg/channel - 1) / 0.005。
pub fn auto_white_balance(img: &ImageBuffer<Rgb<u16>, Vec<u16>>) -> (i32, i32, i32) {
    let (w, h) = img.dimensions();
    let n = w as f64 * h as f64;
    if n < 1.0 {
        return (0, 0, 0);
    }

    let mut sum_r = 0.0_f64;
    let mut sum_g = 0.0_f64;
    let mut sum_b = 0.0_f64;
    for pixel in img.pixels() {
        let Rgb([r, g, b]) = pixel;
        sum_r += f64::from(*r);
        sum_g += f64::from(*g);
        sum_b += f64::from(*b);
    }

    let avg_r = sum_r / n;
    let avg_g = sum_g / n;
    let avg_b = sum_b / n;
    let avg = (avg_r + avg_g + avg_b) / 3.0;

    // shift = ((avg / channel) - 1) / 0.005 = ((avg - channel) / channel) * 200
    let wb_shift_r = if avg_r > 0.0 {
        ((avg - avg_r) / avg_r * 200.0).round().clamp(-100.0, 100.0) as i32
    } else {
        0
    };
    let wb_shift_g = if avg_g > 0.0 {
        ((avg - avg_g) / avg_g * 200.0).round().clamp(-100.0, 100.0) as i32
    } else {
        0
    };
    let wb_shift_b = if avg_b > 0.0 {
        ((avg - avg_b) / avg_b * 200.0).round().clamp(-100.0, 100.0) as i32
    } else {
        0
    };

    (wb_shift_r, wb_shift_g, wb_shift_b)
}

/// 从图像的 (x, y) 位置采样单个像素的 RGB 值。
///
/// 返回 `(R, G, B)`，范围 0..65535（16-bit）。
pub fn eyedrop_color(img: &ImageBuffer<Rgb<u16>, Vec<u16>>, x: u32, y: u32) -> (f32, f32, f32) {
    let pixel = img.get_pixel(x, y);
    let Rgb([r, g, b]) = pixel;
    (f32::from(*r), f32::from(*g), f32::from(*b))
}
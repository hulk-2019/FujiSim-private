//! 白平衡工具：自动白平衡（Gray World）与取色器。

use image::{ImageBuffer, Rgb};

/// Robust Gray World 自动白平衡。
///
/// 跳过接近黑场和高光裁切的像素，再求解令三通道均值相等的 wb_shift_r/g/b。
/// 增益公式：channel * (1 + shift * 0.005) = avg，所以 shift = (avg/channel - 1) / 0.005。
pub fn auto_white_balance(img: &ImageBuffer<Rgb<u16>, Vec<u16>>) -> (i32, i32, i32) {
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return (0, 0, 0);
    }

    let mut sum_r = 0.0_f64;
    let mut sum_g = 0.0_f64;
    let mut sum_b = 0.0_f64;
    let mut count = 0.0_f64;
    let sample_step = (((w as f64 * h as f64) / 300_000.0).sqrt().floor() as usize).max(1);

    for y in (0..h).step_by(sample_step) {
        for x in (0..w).step_by(sample_step) {
            let Rgb([r, g, b]) = img.get_pixel(x, y);
            let max_c = (*r).max(*g).max(*b);
            let min_c = (*r).min(*g).min(*b);
            if max_c < 512 || min_c > 64_000 || max_c > 65_000 {
                continue;
            }

            sum_r += f64::from(*r);
            sum_g += f64::from(*g);
            sum_b += f64::from(*b);
            count += 1.0;
        }
    }

    if count < 1.0 {
        for pixel in img.pixels() {
            let Rgb([r, g, b]) = pixel;
            sum_r += f64::from(*r);
            sum_g += f64::from(*g);
            sum_b += f64::from(*b);
            count += 1.0;
        }
    }

    if count < 1.0 {
        return (0, 0, 0);
    }

    let avg_r = sum_r / count;
    let avg_g = sum_g / count;
    let avg_b = sum_b / count;
    let avg = (avg_r + avg_g + avg_b) / 3.0;

    (shift_for(avg, avg_r), shift_for(avg, avg_g), shift_for(avg, avg_b))
}

/// 从图像的 (x, y) 周围采样小区域 RGB 均值。
///
/// 返回 `(R, G, B)`，范围 0..65535（16-bit）。
pub fn eyedrop_color(img: &ImageBuffer<Rgb<u16>, Vec<u16>>, x: u32, y: u32) -> (f32, f32, f32) {
    let (w, h) = img.dimensions();
    let radius = 4;
    let x0 = x.saturating_sub(radius);
    let y0 = y.saturating_sub(radius);
    let x1 = (x + radius).min(w.saturating_sub(1));
    let y1 = (y + radius).min(h.saturating_sub(1));

    let mut sum_r = 0.0_f64;
    let mut sum_g = 0.0_f64;
    let mut sum_b = 0.0_f64;
    let mut count = 0.0_f64;

    for py in y0..=y1 {
        for px in x0..=x1 {
            let Rgb([r, g, b]) = img.get_pixel(px, py);
            let max_c = (*r).max(*g).max(*b);
            if max_c < 64 {
                continue;
            }

            sum_r += f64::from(*r);
            sum_g += f64::from(*g);
            sum_b += f64::from(*b);
            count += 1.0;
        }
    }

    if count < 1.0 {
        let Rgb([r, g, b]) = img.get_pixel(x, y);
        return (f32::from(*r), f32::from(*g), f32::from(*b));
    }

    ((sum_r / count) as f32, (sum_g / count) as f32, (sum_b / count) as f32)
}

fn shift_for(target: f64, channel: f64) -> i32 {
    if channel > 0.0 {
        ((target - channel) / channel * 200.0).round().clamp(-100.0, 100.0) as i32
    } else {
        0
    }
}

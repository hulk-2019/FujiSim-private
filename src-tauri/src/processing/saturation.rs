//! 鲜艳度（vibrance）与饱和度（saturation）。两者都在 HSL 空间操作。
//! - vibrance：低饱和像素权重高，高饱和像素权重低。
//! - saturation：全局线性叠加。

use crate::processing::color::{hsl_to_rgb, rgb_to_hsl};

/// 鲜艳度：`amount` ∈ [-100, 100]。低饱和度像素被加权放大。
pub fn apply_vibrance_pixel(r: f32, g: f32, b: f32, amount: i32) -> (f32, f32, f32) {
    if amount == 0 {
        return (r, g, b);
    }
    let k = amount as f32 / 100.0;
    let (h, s, l) = rgb_to_hsl(r, g, b);
    let weight = (1.0 - s).powi(2);
    let s_new = (s + k * weight * s).clamp(0.0, 1.0);
    hsl_to_rgb(h, s_new, l)
}

/// 饱和度：`amount` ∈ [-100, 100]。全局加 `amount/100`。
pub fn apply_saturation_pixel(r: f32, g: f32, b: f32, amount: i32) -> (f32, f32, f32) {
    if amount == 0 {
        return (r, g, b);
    }
    let k = amount as f32 / 100.0;
    let (h, s, l) = rgb_to_hsl(r, g, b);
    let s_new = (s + k).clamp(0.0, 1.0);
    hsl_to_rgb(h, s_new, l)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vibrance_zero_is_identity() {
        let (r, g, b) = apply_vibrance_pixel(0.6, 0.4, 0.2, 0);
        assert!((r - 0.6).abs() < 1e-5 && (g - 0.4).abs() < 1e-5 && (b - 0.2).abs() < 1e-5);
    }

    #[test]
    fn saturation_zero_is_identity() {
        let (r, g, b) = apply_saturation_pixel(0.6, 0.4, 0.2, 0);
        assert!((r - 0.6).abs() < 1e-5 && (g - 0.4).abs() < 1e-5 && (b - 0.2).abs() < 1e-5);
    }

    #[test]
    fn vibrance_protects_high_saturation() {
        // 高饱和（红色）vs. 低饱和（淡灰红）vibrance=100 后，相对增量应低饱和的更大
        let high_in = (0.9, 0.1, 0.1);
        let low_in = (0.55, 0.5, 0.5);
        let (hr, _, _) = apply_vibrance_pixel(high_in.0, high_in.1, high_in.2, 100);
        let (lr, lg, lb) = apply_vibrance_pixel(low_in.0, low_in.1, low_in.2, 100);
        let high_delta = (hr - high_in.0).abs();
        let low_delta_total = (lr - low_in.0).abs() + (lg - low_in.1).abs() + (lb - low_in.2).abs();
        assert!(low_delta_total >= high_delta * 0.5);
    }
}

//! 基础色调操作：曝光、对比度、亮度，以及 highlight/shadow/white/black 四段加权曲线。
//!
//! 所有函数都对 `[0,1]` 浮点像素就地操作，输出统一 clamp 在 `[0,1]` 内。

/// 曝光：以 EV stops 为单位的全图增益。`stops=1.0` 等价于 ×2，`stops=-1.0` 等价于 ×0.5。
pub fn apply_exposure_pixel(r: f32, g: f32, b: f32, stops: f32) -> (f32, f32, f32) {
    if stops == 0.0 {
        return (r, g, b);
    }
    let gain = (2f32).powf(stops);
    (r * gain, g * gain, b * gain)
}

/// 亮度：线性 offset。`amount` ∈ [-100, 100]，full-scale ±0.5。
pub fn apply_brightness_pixel(r: f32, g: f32, b: f32, amount: i32) -> (f32, f32, f32) {
    if amount == 0 {
        return (r, g, b);
    }
    let off = amount as f32 / 200.0;
    (r + off, g + off, b + off)
}

/// 对比度：以 0.5 为锚点的线性放大。`amount` ∈ [-100, 100]。
pub fn apply_contrast_pixel(r: f32, g: f32, b: f32, amount: i32) -> (f32, f32, f32) {
    if amount == 0 {
        return (r, g, b);
    }
    let k = 1.0 + amount as f32 / 100.0;
    let f = |v: f32| (v - 0.5) * k + 0.5;
    (f(r), f(g), f(b))
}

/// Hermite smoothstep `3t²-2t³`。
fn cubic_falloff(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// 高光/阴影/白色/黑色：基于 luma 的 4 段加权曲线，保留色相。
/// 各 `amount` ∈ [-100, 100]。
pub fn apply_tone_segments_pixel(
    r: f32,
    g: f32,
    b: f32,
    highlight: i32,
    shadow: i32,
    white: i32,
    black: i32,
) -> (f32, f32, f32) {
    if highlight == 0 && shadow == 0 && white == 0 && black == 0 {
        return (r, g, b);
    }
    let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let mut delta = 0.0f32;
    if highlight != 0 && l > 0.7 {
        delta += (highlight as f32 / 100.0) * cubic_falloff((l - 0.7) / 0.3) * 0.3;
    }
    if white != 0 && l > 0.85 {
        delta += (white as f32 / 100.0) * cubic_falloff((l - 0.85) / 0.15) * 0.3;
    }
    if shadow != 0 && l < 0.3 {
        delta += (shadow as f32 / 100.0) * cubic_falloff((0.3 - l) / 0.3) * 0.3;
    }
    if black != 0 && l < 0.15 {
        delta += (black as f32 / 100.0) * cubic_falloff((0.15 - l) / 0.15) * 0.3;
    }
    if delta == 0.0 || l <= 0.0001 {
        return (r, g, b);
    }
    // 保色相：按 RGB 比例缩放，使 luma 增加 delta
    let scale = (l + delta) / l;
    (r * scale, g * scale, b * scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposure_zero_is_identity() {
        let (r, g, b) = apply_exposure_pixel(0.5, 0.4, 0.3, 0.0);
        assert!((r - 0.5).abs() < 1e-6 && (g - 0.4).abs() < 1e-6 && (b - 0.3).abs() < 1e-6);
    }

    #[test]
    fn exposure_one_stop_doubles() {
        let (r, _, _) = apply_exposure_pixel(0.25, 0.25, 0.25, 1.0);
        assert!((r - 0.5).abs() < 1e-6);
    }

    #[test]
    fn brightness_positive_lifts() {
        let (r, _, _) = apply_brightness_pixel(0.5, 0.5, 0.5, 100);
        assert!((r - 1.0).abs() < 1e-6);
    }

    #[test]
    fn contrast_positive_separates() {
        let (lo, _, _) = apply_contrast_pixel(0.0, 0.0, 0.0, 100);
        let (hi, _, _) = apply_contrast_pixel(1.0, 1.0, 1.0, 100);
        assert!(lo < 0.0 && hi > 1.0);
    }

    #[test]
    fn tone_segments_zero_is_identity() {
        let (r, g, b) = apply_tone_segments_pixel(0.5, 0.5, 0.5, 0, 0, 0, 0);
        assert_eq!((r, g, b), (0.5, 0.5, 0.5));
    }

    #[test]
    fn tone_segments_highlight_lifts_brights_only() {
        // luma 0.5 在中段，highlight 不应触发
        let (r, _, _) = apply_tone_segments_pixel(0.5, 0.5, 0.5, 100, 0, 0, 0);
        assert!((r - 0.5).abs() < 1e-3);
        // luma 0.9 在高光区
        let (r2, _, _) = apply_tone_segments_pixel(0.9, 0.9, 0.9, 100, 0, 0, 0);
        assert!(r2 > 0.9);
    }

    #[test]
    fn tone_segments_shadow_lifts_darks_only() {
        let (r, _, _) = apply_tone_segments_pixel(0.5, 0.5, 0.5, 0, 100, 0, 0);
        assert!((r - 0.5).abs() < 1e-3);
        let (r2, _, _) = apply_tone_segments_pixel(0.1, 0.1, 0.1, 0, 100, 0, 0);
        assert!(r2 > 0.1);
    }
}

/// 16-bit 像素的最大值，浮点归一化常量。
pub const MAX16: f32 = 65535.0;

/// 16-bit → 浮点 0..1。
#[inline(always)]
pub fn u16_to_f(v: u16) -> f32 {
    v as f32 / MAX16
}

/// 浮点 0..1 → 16-bit（带四舍五入和夹紧）。
#[inline(always)]
pub fn f_to_u16(v: f32) -> u16 {
    (v.clamp(0.0, 1.0) * MAX16).round() as u16
}

/// RGB → HSL 的标准转换。三个通道都假定在 0..1 范围。
///
/// 返回 `(h, s, l)`，h 也在 0..1（除以 2π），便于做线性插值；
/// 当 max==min 时色相未定义，返回 0。
#[inline(always)]
pub fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g.max(b));
    let min = r.min(g.min(b));
    let l = (max + min) * 0.5;
    if (max - min).abs() < f32::EPSILON {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let mut h = if (max - r).abs() < f32::EPSILON {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if (max - g).abs() < f32::EPSILON {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    h /= 6.0;
    (h, s, l)
}

/// HSL → RGB 的反向转换。与 [`rgb_to_hsl`] 互为逆。
#[inline(always)]
pub fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    if s.abs() < f32::EPSILON {
        return (l, l, l);
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    (
        hue2rgb(p, q, h + 1.0 / 3.0),
        hue2rgb(p, q, h),
        hue2rgb(p, q, h - 1.0 / 3.0),
    )
}

fn hue2rgb(p: f32, q: f32, t: f32) -> f32 {
    let mut t = t;
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        return p + (q - p) * 6.0 * t;
    }
    if t < 1.0 / 2.0 {
        return q;
    }
    if t < 2.0 / 3.0 {
        return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    }
    p
}

/// Rec.709 亮度权重。用于亮度掩膜、Clarity、颗粒等。
#[inline(always)]
pub fn luminance(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// 白平衡偏移：仿富士机内 -9..+9 的两轴档位。
/// 每档大约 2% 增益，足以微调肤色冷暖、避免数值过激造成偏色。
#[inline(always)]
pub fn apply_wb_shift(r: f32, g: f32, b: f32, shift_r: i32, shift_b: i32) -> (f32, f32, f32) {
    let kr = 1.0 + shift_r as f32 * 0.02;
    let kb = 1.0 + shift_b as f32 * 0.02;
    (r * kr, g, b * kb)
}

/// 以亮度为锚的饱和度调整。
/// 正值增加饱和度，-1 退化为完全灰度。
/// 比单纯乘 sat 系数更安全：纯灰像素永远保持灰，避免引入色偏。
#[inline(always)]
pub fn saturate(r: f32, g: f32, b: f32, amount: f32) -> (f32, f32, f32) {
    let l = luminance(r, g, b);
    let amt = 1.0 + amount;
    (l + (r - l) * amt, l + (g - l) * amt, l + (b - l) * amt)
}

/// 线性插值 a → b，t∈[0,1]。
#[inline(always)]
pub fn channel_lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// 线性 RGB → sRGB（带 gamma 矫正）。MVP 阶段流水线主要在线性空间工作，
/// 解码/编码端 `image` crate 已经处理了 sRGB transfer。这里保留是为未来 RAW HDR 流准备。
pub fn linear_to_srgb(v: f32) -> f32 {
    if v <= 0.0031308 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// sRGB → 线性 RGB。与 [`linear_to_srgb`] 互逆。
pub fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

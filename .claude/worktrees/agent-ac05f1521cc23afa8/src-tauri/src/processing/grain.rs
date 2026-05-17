use rand::{rngs::StdRng, Rng, SeedableRng};

/// 颗粒强度档位。富士机内菜单同名：Off/Weak/Strong；这里多加一档 Medium 让滑块更有渐变感。
#[derive(Debug, Clone, Copy)]
pub enum GrainStrength {
    None,
    Weak,
    Medium,
    Strong,
}

/// 颗粒尺寸。Small=每像素一个颗粒；Large=每 2×2 像素一组颗粒，视觉上更"粗"。
#[derive(Debug, Clone, Copy)]
pub enum GrainSize {
    Small,
    Large,
}

impl GrainStrength {
    /// 从前端传入的字符串解析。任何无法识别的值都按 `None` 处理（不抛错）。
    pub fn parse(s: Option<&str>) -> GrainStrength {
        match s.unwrap_or("None") {
            "Weak" => GrainStrength::Weak,
            "Medium" => GrainStrength::Medium,
            "Strong" => GrainStrength::Strong,
            _ => GrainStrength::None,
        }
    }
    /// 颗粒振幅（0..1 空间内）。数值是反复试出来的，让 Weak 看得见但不刺眼，Strong 接近 ISO6400 胶片质感。
    pub fn amount(self) -> f32 {
        match self {
            GrainStrength::None => 0.0,
            GrainStrength::Weak => 0.012,
            GrainStrength::Medium => 0.024,
            GrainStrength::Strong => 0.040,
        }
    }
}

impl GrainSize {
    pub fn parse(s: Option<&str>) -> GrainSize {
        match s.unwrap_or("Small") {
            "Large" => GrainSize::Large,
            _ => GrainSize::Small,
        }
    }
    /// 一个颗粒覆盖多少像素的边长（2 表示 2×2 块）。
    pub fn cell(self) -> u32 {
        match self {
            GrainSize::Small => 1,
            GrainSize::Large => 2,
        }
    }
}

/// 把胶片颗粒合成到一张连续的 RGB 浮点缓冲区（`[r, g, b, r, g, b, ...]`）。
///
/// 实现要点：
/// - 使用 Box-Muller 变换生成正态分布噪声，比均匀噪声更接近胶片视觉感受；
/// - 同一颗粒在 RGB 三通道使用相同的 delta，得到"中性灰颗粒"而不是彩色噪点；
/// - 用 `4*L*(1-L)` 作为亮度掩膜：中灰处颗粒最重，纯黑/纯白处几乎为零，符合胶片化学特性；
/// - `seed` 固定时输出可复现，便于"导出图像和预览图像颗粒位置一致"。
pub fn apply_grain(
    buf: &mut [f32],
    width: u32,
    height: u32,
    strength: GrainStrength,
    size: GrainSize,
    seed: u64,
) {
    let amp = strength.amount();
    if amp <= 0.0 {
        return;
    }
    let mut rng = StdRng::seed_from_u64(seed);
    let cell = size.cell();
    // 颗粒图按 cell 尺寸缩水，再在合成时按 cell 复制，从而得到"大颗粒"
    let cells_w = width.div_ceil(cell);
    let cells_h = height.div_ceil(cell);
    let mut noise = vec![0.0f32; (cells_w * cells_h) as usize];
    for v in noise.iter_mut() {
        // Box-Muller：u1, u2 ~ U(0,1)  →  z ~ N(0,1)
        let u1: f32 = rng.gen();
        let u2: f32 = rng.gen();
        let z = (-2.0 * (u1.max(1e-6)).ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos();
        *v = z * amp;
    }
    for y in 0..height {
        let cy = y / cell;
        for x in 0..width {
            let cx = x / cell;
            let n = noise[(cy * cells_w + cx) as usize];
            let i = ((y * width + x) * 3) as usize;
            // Rec.709 亮度权重；掩膜峰值在 L=0.5（中灰）处，纯白/黑两端逼近 0
            let l = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
            let mask = 4.0 * l * (1.0 - l);
            let delta = n * mask;
            buf[i] = (buf[i] + delta).clamp(0.0, 1.0);
            buf[i + 1] = (buf[i + 1] + delta).clamp(0.0, 1.0);
            buf[i + 2] = (buf[i + 2] + delta).clamp(0.0, 1.0);
        }
    }
}

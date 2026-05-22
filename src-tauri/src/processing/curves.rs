use crate::processing::color;
use splines::{Interpolation, Key, Spline};
use crate::processing::pipeline::CurvePoint;

/// 256 项查找表，用于把"输入亮度 0..1"映射到"输出亮度 0..1"。
///
/// 把曲线烘焙成 LUT 是性能优化关键：
/// - 后续每个像素只需一次数组索引 + 线性插值，避免对每个像素做 tanh/powf 等浮点运算；
/// - 在百万像素图上能省下数十毫秒。
pub struct ToneCurve {
    pub lut: [f32; 256],
}

impl ToneCurve {
    /// 恒等曲线：`y = x`。用于不需要色调改造的场景。
    pub fn identity() -> Self {
        let mut lut = [0.0; 256];
        for (i, slot) in lut.iter_mut().enumerate() {
            *slot = i as f32 / 255.0;
        }
        ToneCurve { lut }
    }

    /// 构造一条复合曲线，由"对比 + 阴影抬升 + 高光压缩"三段叠加而成。
    ///
    /// 参数：
    /// - `highlight`：高光色调，范围 -1..1。正值提亮高光（Hard），负值压制高光（Soft）。
    /// - `shadow`：阴影抬升，范围 -1..1。正值提亮阴影区，负值压暗阴影。
    /// - `contrast`：S 形 / 反 S 形对比，范围 -1..1。正值更硬朗、负值更柔和。
    pub fn build(highlight: f32, shadow: f32, contrast: f32) -> Self {
        let mut lut = [0.0; 256];
        for (i, slot) in lut.iter_mut().enumerate() {
            let x = i as f32 / 255.0;
            let mut y = x;

            // 正向对比：把直线缓缓"扭"成 S 形，让中灰附近变陡
            let s_curve = (x - 0.5).tanh() * 0.5 + 0.5;
            y = color::channel_lerp(y, s_curve, contrast.clamp(-1.0, 1.0).max(0.0) * 0.6);
            // 反向对比：拉平直线，让全图更"软"
            if contrast < 0.0 {
                y = color::channel_lerp(y, 0.18 + (y - 0.18) * 0.6, -contrast * 0.6);
            }

            // 阴影掩膜：(1-x)^2 在暗部权重最高，越往亮部影响越小
            let shadow_mask = (1.0 - x).powf(2.0);
            y += shadow * 0.35 * shadow_mask;

            // 高光掩膜：x^2 在亮部权重最高，对高光的抑制不会"误伤"中间调
            let highlight_mask = x.powf(2.0);
            y += highlight * 0.35 * highlight_mask;

            *slot = y.clamp(0.0, 1.0);
        }
        ToneCurve { lut }
    }

    /// Build a ToneCurve LUT from user-supplied control points using CatmullRom spline.
    /// Points are sorted by x. If fewer than 2 points, returns identity.
    /// Ghost points are added at both ends to ensure smooth interpolation at boundaries.
    pub fn from_points(points: &[CurvePoint]) -> Self {
        if points.len() < 2 {
            return Self::identity();
        }

        // Sort by x ascending
        let mut sorted = points.to_vec();
        sorted.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));

        // Build spline keys; add ghost points at both ends for CatmullRom boundary stability
        let first = &sorted[0];
        let last = &sorted[sorted.len() - 1];

        let mut keys: Vec<Key<f32, f32>> = Vec::with_capacity(sorted.len() + 2);
        // Ghost point before first (same y, slightly before x)
        keys.push(Key::new(first.x - 0.01, first.y, Interpolation::CatmullRom));
        for pt in &sorted {
            keys.push(Key::new(pt.x, pt.y, Interpolation::CatmullRom));
        }
        // Ghost point after last (same y, slightly after x)
        keys.push(Key::new(last.x + 0.01, last.y, Interpolation::CatmullRom));

        let spline = Spline::from_vec(keys);

        let mut lut = [0.0f32; 256];
        for (i, slot) in lut.iter_mut().enumerate() {
            let x = i as f32 / 255.0;
            let y = spline.clamped_sample(x).unwrap_or(x);
            *slot = y.clamp(0.0, 1.0);
        }
        ToneCurve { lut }
    }

    /// 用线性插值把 LUT 应用到一个 0..1 值。
    /// 输入超出 [0,1] 会被夹紧。
    #[inline(always)]
    pub fn apply(&self, v: f32) -> f32 {
        let idx = (v.clamp(0.0, 1.0) * 255.0) as usize;
        if idx >= 255 {
            return self.lut[255];
        }
        let f = v * 255.0 - idx as f32;
        let a = self.lut[idx];
        let b = self.lut[idx + 1];
        a + (b - a) * f
    }
}

/// 在基础亮度曲线之上，为 R/G/B 三通道各自做一次"轻微弯折"，
/// 这是程序化富士预设里"分通道色彩偏好"的实现方式。
///
/// 例如 Velvia 的红色调倾向就是通过给 R 通道 `r_tilt` 加正值实现的。
/// 弯折公式 `x + tilt * x*(1-x) * 1.6` 在两端为零、中间最大，
/// 保证不会让纯白/纯黑像素跑飞色。
pub fn build_per_channel_curves(
    base_curve: &ToneCurve,
    r_tilt: f32,
    g_tilt: f32,
    b_tilt: f32,
) -> (ToneCurve, ToneCurve, ToneCurve) {
    let bend = |tilt: f32| -> ToneCurve {
        let mut lut = [0.0; 256];
        for (i, slot) in lut.iter_mut().enumerate() {
            let x = i as f32 / 255.0;
            let lifted = x + tilt * (x * (1.0 - x)) * 1.6;
            *slot = base_curve.apply(lifted.clamp(0.0, 1.0));
        }
        ToneCurve { lut }
    };
    (bend(r_tilt), bend(g_tilt), bend(b_tilt))
}

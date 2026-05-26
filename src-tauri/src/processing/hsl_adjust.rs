//! HSL 色相分段调整模块。
//!
//! 将色相轮等分为 8 个区间，每个区间中心施加独立的色相/饱和度/明度偏移。
//! 区间边界采用高斯软加权，避免硬切割产生的色带。

use crate::processing::color::{hsl_to_rgb, rgb_to_hsl};
use rayon::prelude::*;

/// 8 个色相区间中心（度），等距覆盖 0°..360°。
const HUE_CENTERS: [f32; 8] = [0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0];

/// 高斯权重 σ（度）。值越大，相邻区间过渡越柔和。
const SIGMA: f32 = 30.0;

/// 预计算高斯公式的 `1 / (2σ²)`，避免运行时重复计算。
const INV_TWO_SIGMA_SQ: f32 = 1.0 / (2.0 * SIGMA * SIGMA);

/// HSL 分段调整参数。
///
/// 三个 `[f32; 8]` 分别对应 8 个色相区间的偏移量：
/// - `hue_shifts`：色相偏移（度）
/// - `sat_shifts`：饱和度偏移（-100..+100，映射到 -1..+1）
/// - `lum_shifts`：明度偏移（-100..+100，映射到 -1..+1）
#[derive(Clone, Debug, Default)]
pub struct HslParams {
    pub hue_shifts: [f32; 8],
    pub sat_shifts: [f32; 8],
    pub lum_shifts: [f32; 8],
}

impl HslParams {
    /// 如果所有偏移都为零，说明是恒等变换，可跳过处理。
    pub fn is_identity(&self) -> bool {
        self.hue_shifts.iter().all(|&v| v == 0.0)
            && self.sat_shifts.iter().all(|&v| v == 0.0)
            && self.lum_shifts.iter().all(|&v| v == 0.0)
    }
}

/// 计算色相空间中的最短距离（度），处理 360° 环绕。
#[inline(always)]
fn hue_distance(h: f32, center: f32) -> f32 {
    let d = (h - center).abs();
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

/// 对 RGBA f32 像素缓冲区施加 HSL 分段调整。
///
/// - `buf`：RGBA 交织的 f32 缓冲区，长度必须是 4 的倍数
/// - `params`：8 区间的色相/饱和度/明度偏移
///
/// 使用 `rayon::par_chunks_mut(4)` 并行处理每个像素。
pub fn apply_hsl_adjust(buf: &mut [f32], params: &HslParams) {
    if params.is_identity() {
        return;
    }

    buf.par_chunks_mut(4).for_each(|px| {
        let r = px[0];
        let g = px[1];
        let b = px[2];

        // rgb_to_hsl 返回 h 在 0..1，转换为度数便于与 HUE_CENTERS 对齐
        let (h_norm, s, l) = rgb_to_hsl(r, g, b);
        let h_deg = h_norm * 360.0;

        // 计算高斯权重并归一化
        let weights: [f32; 8] = std::array::from_fn(|i| {
            let dist = hue_distance(h_deg, HUE_CENTERS[i]);
            (-dist * dist * INV_TWO_SIGMA_SQ).exp()
        });
        let w_sum: f32 = weights.iter().copied().sum();
        if w_sum < f32::EPSILON {
            return;
        }
        let inv_w_sum = 1.0 / w_sum;

        // 加权平均偏移
        let mut hue_delta = 0.0_f32;
        let mut sat_delta = 0.0_f32;
        let mut lum_delta = 0.0_f32;
        for (((&w, &hs), &ss), &ls) in weights
            .iter()
            .zip(params.hue_shifts.iter())
            .zip(params.sat_shifts.iter())
            .zip(params.lum_shifts.iter())
        {
            let wn = w * inv_w_sum;
            hue_delta += wn * hs;
            sat_delta += wn * ss;
            lum_delta += wn * ls;
        }

        // 应用偏移
        let new_h = ((h_deg + hue_delta) % 360.0 + 360.0) % 360.0;
        let new_s = (s + sat_delta / 100.0).clamp(0.0, 1.0);
        let new_l = (l + lum_delta / 100.0).clamp(0.0, 1.0);

        // 转回 0..1 再做 HSL→RGB
        let (nr, ng, nb) = hsl_to_rgb(new_h / 360.0, new_s, new_l);
        px[0] = nr;
        px[1] = ng;
        px[2] = nb;
        // px[3] (alpha) 保持不变
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 全零参数应保持像素不变。
    #[test]
    fn identity_params_no_change() {
        let mut buf = [0.5, 0.2, 0.8, 1.0];
        let params = HslParams::default();
        apply_hsl_adjust(&mut buf, &params);
        assert!((buf[0] - 0.5).abs() < 1e-4);
        assert!((buf[1] - 0.2).abs() < 1e-4);
        assert!((buf[2] - 0.8).abs() < 1e-4);
        assert!((buf[3] - 1.0).abs() < 1e-4);
    }

    /// 纯红像素 (h≈0°) 施加全区间 +360° 偏移应回到同一色相。
    #[test]
    fn hue_shift_wrapping() {
        let mut buf = [1.0, 0.0, 0.0, 1.0]; // 纯红
        // 全区间 +360° 偏移，归一化后 hue_delta = 360°，应绕回原色相
        let params = HslParams {
            hue_shifts: [360.0; 8],
            ..Default::default()
        };
        apply_hsl_adjust(&mut buf, &params);
        // 红色绕回 360° 仍应为红色
        assert!(buf[0] > 0.99, "R should remain near 1.0, got {}", buf[0]);
        assert!(buf[1] < 0.01, "G should remain near 0.0, got {}", buf[1]);
        assert!(buf[2] < 0.01, "B should remain near 0.0, got {}", buf[2]);
    }

    /// 饱和度偏移应正确增减饱和度。
    #[test]
    fn saturation_shift() {
        // 中等饱和的颜色
        let mut buf = [0.6, 0.3, 0.3, 1.0];
        let original_h = rgb_to_hsl(buf[0], buf[1], buf[2]).1;
        // 全区间 +50 饱和度
        let params = HslParams {
            sat_shifts: [50.0; 8],
            ..Default::default()
        };
        apply_hsl_adjust(&mut buf, &params);
        let new_h = rgb_to_hsl(buf[0], buf[1], buf[2]).1;
        assert!(
            new_h > original_h,
            "Saturation should increase: {} -> {}",
            original_h,
            new_h
        );
    }

    /// 对蓝色区域 (h≈240°) 施加色相偏移应产生可观测的色相变化。
    #[test]
    fn hue_shift_blue_range() {
        // 纯蓝 ≈ 240°
        let mut buf = [0.0, 0.0, 1.0, 1.0];
        let original_h = rgb_to_hsl(buf[0], buf[1], buf[2]).0 * 360.0;
        let mut params = HslParams::default();
        // 索引 5 = 225° 和索引 6 = 270° 都靠近蓝色
        params.hue_shifts[5] = 30.0;
        params.hue_shifts[6] = 30.0;
        apply_hsl_adjust(&mut buf, &params);
        let new_h = rgb_to_hsl(buf[0], buf[1], buf[2]).0 * 360.0;
        // 色相应增加（向紫/红移动）
        let delta = new_h - original_h;
        assert!(
            delta.abs() > 5.0,
            "Hue should shift noticeably: original={} new={} delta={}",
            original_h,
            new_h,
            delta
        );
    }
}

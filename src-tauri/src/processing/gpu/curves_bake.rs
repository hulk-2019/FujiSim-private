//! CPU-side bake of all four tone curves (rgb / r / g / b) to a single
//! 1024 × 4-channel f32 LUT, ready for upload as an r16float 2D texture
//! of shape (1024, 4) — row 0 is R, row 1 is G, row 2 is B, row 3 is RGB-master.

use crate::processing::curves::{self, ToneCurve};
use crate::processing::fuji;
use crate::processing::pipeline::FilterSettings;

pub const LUT_LEN: usize = 1024;

/// Returns 4 LUTs of length LUT_LEN, in order [R, G, B, master_RGB].
pub fn bake(settings: &FilterSettings) -> [Vec<f32>; 4] {
    let profile = fuji::lookup(&settings.base_simulation);
    let base = ToneCurve::build(0.0, 0.0, profile.contrast);
    let (rc, gc, bc) =
        curves::build_per_channel_curves(&base, profile.r_tilt, profile.g_tilt, profile.b_tilt);

    let user_rgb = settings
        .tone_curve
        .as_ref()
        .filter(|tc| !tc.rgb.is_empty())
        .map(|tc| ToneCurve::from_points(&tc.rgb));
    let user_r = settings
        .tone_curve
        .as_ref()
        .filter(|tc| !tc.r.is_empty())
        .map(|tc| ToneCurve::from_points(&tc.r));
    let user_g = settings
        .tone_curve
        .as_ref()
        .filter(|tc| !tc.g.is_empty())
        .map(|tc| ToneCurve::from_points(&tc.g));
    let user_b = settings
        .tone_curve
        .as_ref()
        .filter(|tc| !tc.b.is_empty())
        .map(|tc| ToneCurve::from_points(&tc.b));

    let mut r_lut = vec![0.0f32; LUT_LEN];
    let mut g_lut = vec![0.0f32; LUT_LEN];
    let mut b_lut = vec![0.0f32; LUT_LEN];
    let mut m_lut = vec![0.0f32; LUT_LEN];

    for (i, (((r_slot, g_slot), b_slot), m_slot)) in r_lut
        .iter_mut()
        .zip(g_lut.iter_mut())
        .zip(b_lut.iter_mut())
        .zip(m_lut.iter_mut())
        .enumerate()
    {
        let x = i as f32 / (LUT_LEN as f32 - 1.0);
        let mut r = rc.apply(x);
        let mut g = gc.apply(x);
        let mut b = bc.apply(x);
        if let Some(c) = &user_r {
            r = c.apply(r);
        }
        if let Some(c) = &user_g {
            g = c.apply(g);
        }
        if let Some(c) = &user_b {
            b = c.apply(b);
        }
        let m = if let Some(c) = &user_rgb {
            c.apply(x)
        } else {
            x
        };
        *r_slot = r.clamp(0.0, 1.0);
        *g_slot = g.clamp(0.0, 1.0);
        *b_slot = b.clamp(0.0, 1.0);
        *m_slot = m.clamp(0.0, 1.0);
    }

    [r_lut, g_lut, b_lut, m_lut]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_settings_produces_near_identity_master() {
        let s = FilterSettings::default();
        let l = bake(&s);
        // Pass-Through profile has zero tilts → R/G/B LUTs equal master (which is identity).
        for (i, &val) in l[3].iter().enumerate() {
            let x = i as f32 / (LUT_LEN as f32 - 1.0);
            assert!((val - x).abs() < 1e-6, "master not identity at {i}");
        }
    }
}

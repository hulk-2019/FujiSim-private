//! GPU-side uniform layout for the color_fused pass.
//!
//! Field order MUST match the WGSL `Uniforms` struct in `shaders/color_fused.wgsl`.

use crate::processing::fuji;
use crate::processing::pipeline::FilterSettings;

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct FilterUniforms {
    // Step [1] white balance
    pub wb_shift_r: f32,
    pub wb_shift_b: f32,
    // Step [2] exposure
    pub exposure: f32,
    // Step [3] brightness/contrast
    pub brightness: f32,
    pub contrast: f32,
    // Step [4] 4-segment tone
    pub highlight: f32,
    pub shadow: f32,
    pub white: f32,
    pub black: f32,
    // Step [5] curve toggles (LUT-driven; 0 = skip per-channel sample)
    pub has_master_curve: u32,
    // Explicit padding: has_master_curve sits at offset 36 (after 9 × f32).
    // WGSL naga inserts 8 bytes here so split_hi vec4 starts at offset 48 (16-byte aligned).
    pub _pad_after_has_master_curve: [u32; 2],
    // Step [6] split toning + global channel shift (vec4 for std140 alignment)
    pub split_hi_r: f32,
    pub split_hi_g: f32,
    pub split_hi_b: f32,
    pub _pad6a: f32,
    pub split_sh_r: f32,
    pub split_sh_g: f32,
    pub split_sh_b: f32,
    pub _pad6b: f32,
    pub channel_shift_r: f32,
    pub channel_shift_g: f32,
    pub channel_shift_b: f32,
    pub _pad6c: f32,
    // Step [7] vibrance + saturation
    pub vibrance: f32,
    pub saturation: f32,
    // Step [9] fade
    pub fade: f32,
    // Step [10] monochrome
    pub monochrome: u32,
    pub mono_tint_r: f32,
    pub mono_tint_g: f32,
    pub mono_tint_b: f32,
    pub _pad10: f32,
    // Output dimensions (so shader can early-exit)
    pub width: u32,
    pub height: u32,
    pub _pad_tail: [u32; 2],
}

impl FilterUniforms {
    pub fn from_settings(s: &FilterSettings, width: u32, height: u32) -> Self {
        let p = fuji::lookup(&s.base_simulation);
        // preset.saturation is -1..1; user color_saturation is -100..100 (i32).
        // Combine here so the shader does a single multiply.
        let combined_sat = s.color_saturation as f32 + p.saturation * 100.0;
        Self {
            wb_shift_r: s.wb_shift_r as f32,
            wb_shift_b: s.wb_shift_b as f32,
            exposure: s.exposure,
            brightness: s.brightness as f32,
            contrast: s.contrast as f32,
            highlight: s.highlight_tone as f32,
            shadow: s.shadow_tone as f32,
            white: s.white as f32,
            black: s.black as f32,
            has_master_curve: s
                .tone_curve
                .as_ref()
                .map(|tc| !tc.rgb.is_empty())
                .unwrap_or(false) as u32,
            _pad_after_has_master_curve: [0, 0],
            split_hi_r: p.split_highlight.0,
            split_hi_g: p.split_highlight.1,
            split_hi_b: p.split_highlight.2,
            _pad6a: 0.0,
            split_sh_r: p.split_shadow.0,
            split_sh_g: p.split_shadow.1,
            split_sh_b: p.split_shadow.2,
            _pad6b: 0.0,
            channel_shift_r: p.red_shift * 0.05,
            channel_shift_g: p.green_shift * 0.05,
            channel_shift_b: p.blue_shift * 0.05,
            _pad6c: 0.0,
            vibrance: s.vibrance as f32,
            saturation: combined_sat,
            fade: p.fade,
            monochrome: p.monochrome as u32,
            mono_tint_r: p.mono_tint.0,
            mono_tint_g: p.mono_tint.1,
            mono_tint_b: p.mono_tint.2,
            _pad10: 0.0,
            width,
            height,
            _pad_tail: [0, 0],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_settings_default_is_well_formed() {
        let s = FilterSettings::default();
        let u = FilterUniforms::from_settings(&s, 1280, 853);
        assert_eq!(u.width, 1280);
        assert_eq!(u.height, 853);
        assert_eq!(u.has_master_curve, 0);
        assert_eq!(u.monochrome, 0);
        // bytemuck::Pod proven at compile time; instead check WGSL std140 invariants:
        let size = std::mem::size_of::<FilterUniforms>();
        assert_eq!(
            size % 16,
            0,
            "FilterUniforms size {size} must be a multiple of 16 for WGSL uniform binding"
        );
        assert_eq!(
            size, 144,
            "FilterUniforms size changed; update WGSL shader if intentional"
        );
        // vec4 fields must be at 16-byte-aligned offsets.
        // offset_of! is stable from 1.77; use manual address arithmetic for MSRV 1.75.
        let base = &u as *const _ as usize;
        let off_split_hi = (&u.split_hi_r as *const _ as usize) - base;
        let off_split_sh = (&u.split_sh_r as *const _ as usize) - base;
        let off_channel = (&u.channel_shift_r as *const _ as usize) - base;
        let off_mono_tint = (&u.mono_tint_r as *const _ as usize) - base;
        assert_eq!(
            off_split_hi % 16,
            0,
            "split_hi_r offset {off_split_hi} not 16-byte aligned"
        );
        assert_eq!(
            off_split_sh % 16,
            0,
            "split_sh_r offset {off_split_sh} not 16-byte aligned"
        );
        assert_eq!(
            off_channel % 16,
            0,
            "channel_shift_r offset {off_channel} not 16-byte aligned"
        );
        assert_eq!(
            off_mono_tint % 16,
            0,
            "mono_tint_r offset {off_mono_tint} not 16-byte aligned"
        );
    }
}

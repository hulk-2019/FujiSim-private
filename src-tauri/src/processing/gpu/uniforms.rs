//! GPU-side uniform layout for the color_fused pass.
//!
//! Field order MUST match the WGSL `Uniforms` struct in `shaders/color_fused.wgsl`.

use crate::processing::foto;
use crate::processing::pipeline::FilterSettings;

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct FilterUniforms {
    // Step [1] white balance
    pub wb_shift_r: f32,
    pub wb_shift_b: f32,
    pub wb_shift_g: f32,
    pub _pad_wb: f32,
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
    // Step [7b] HSL per-channel adjustment (8 colors × 3 components = 24 f32)
    pub hsl_red_hue: f32,
    pub hsl_red_sat: f32,
    pub hsl_red_lum: f32,
    pub hsl_orange_hue: f32,
    pub hsl_orange_sat: f32,
    pub hsl_orange_lum: f32,
    pub hsl_yellow_hue: f32,
    pub hsl_yellow_sat: f32,
    pub hsl_yellow_lum: f32,
    pub hsl_green_hue: f32,
    pub hsl_green_sat: f32,
    pub hsl_green_lum: f32,
    pub hsl_aqua_hue: f32,
    pub hsl_aqua_sat: f32,
    pub hsl_aqua_lum: f32,
    pub hsl_blue_hue: f32,
    pub hsl_blue_sat: f32,
    pub hsl_blue_lum: f32,
    pub hsl_purple_hue: f32,
    pub hsl_purple_sat: f32,
    pub hsl_purple_lum: f32,
    pub hsl_magenta_hue: f32,
    pub hsl_magenta_sat: f32,
    pub hsl_magenta_lum: f32,
    // Output dimensions (so shader can early-exit)
    pub width: u32,
    pub height: u32,
    pub _pad_tail: [u32; 2],
}

impl FilterUniforms {
    pub fn from_settings(s: &FilterSettings, width: u32, height: u32) -> Self {
        let p = foto::lookup(&s.base_simulation);
        // preset.saturation is -1..1; user color_saturation is -100..100 (i32).
        // Combine here so the shader does a single multiply.
        let combined_sat = s.color_saturation as f32 + p.saturation * 100.0;
        Self {
            wb_shift_r: s.wb_shift_r as f32,
            wb_shift_b: s.wb_shift_b as f32,
            wb_shift_g: s.wb_shift_g as f32,
            _pad_wb: 0.0,
            exposure: s.exposure,
            brightness: s.brightness as f32,
            contrast: s.contrast as f32,
            highlight: s.highlight_tone as f32,
            shadow: s.shadow_tone as f32,
            white: s.white as f32,
            black: s.black as f32,
            // has_master_curve is reserved/unused: the shader no longer samples row 3
            // (user_rgb is now baked into per-channel rows in curves_bake.rs).
            // Kept at 0 for layout stability — do not remove the field.
            has_master_curve: 0,
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
            // Step [7b] HSL per-channel adjustment
            hsl_red_hue: s.hsl_red_hue,
            hsl_red_sat: s.hsl_red_sat,
            hsl_red_lum: s.hsl_red_lum,
            hsl_orange_hue: s.hsl_orange_hue,
            hsl_orange_sat: s.hsl_orange_sat,
            hsl_orange_lum: s.hsl_orange_lum,
            hsl_yellow_hue: s.hsl_yellow_hue,
            hsl_yellow_sat: s.hsl_yellow_sat,
            hsl_yellow_lum: s.hsl_yellow_lum,
            hsl_green_hue: s.hsl_green_hue,
            hsl_green_sat: s.hsl_green_sat,
            hsl_green_lum: s.hsl_green_lum,
            hsl_aqua_hue: s.hsl_aqua_hue,
            hsl_aqua_sat: s.hsl_aqua_sat,
            hsl_aqua_lum: s.hsl_aqua_lum,
            hsl_blue_hue: s.hsl_blue_hue,
            hsl_blue_sat: s.hsl_blue_sat,
            hsl_blue_lum: s.hsl_blue_lum,
            hsl_purple_hue: s.hsl_purple_hue,
            hsl_purple_sat: s.hsl_purple_sat,
            hsl_purple_lum: s.hsl_purple_lum,
            hsl_magenta_hue: s.hsl_magenta_hue,
            hsl_magenta_sat: s.hsl_magenta_sat,
            hsl_magenta_lum: s.hsl_magenta_lum,
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
            size, 240,
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

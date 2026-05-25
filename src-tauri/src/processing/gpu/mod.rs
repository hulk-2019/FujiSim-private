//! GPU compute pipeline for the color flow.
//!
//! Owns a single [`context::GpuContext`] for the process. See
//! `docs/superpowers/specs/2026-05-25-webgpu-pipeline-design.md` for the design.

pub mod context;
pub mod curves_bake;
pub mod passes;
pub mod passthrough;
pub mod uniforms;
pub mod upload;

#[cfg(test)]
mod tests;

use crate::error::Result;
use crate::processing::lut::Lut3D;
use crate::processing::pipeline::FilterSettings;
use image::{ImageBuffer, Rgb};

/// GPU pipeline entry. Currently runs only steps [1]-[10] on GPU,
/// then hands off to the existing CPU code for [11]-[14] via a small
/// helper. Will be expanded in M3 to keep more steps on the GPU.
pub fn process_image_gpu(
    gpu: &context::GpuContext,
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    settings: &FilterSettings,
    lut: Option<&Lut3D>,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    if lut.is_none() && settings.is_identity() {
        return Ok(src.clone());
    }
    // Step [1]-[10] on GPU.
    let after_color = passes::color_fused::run_color_fused_only(gpu, src, settings)?;

    // Steps [11]-[14] still on CPU. Build a "rest only" settings:
    //   - skip steps [1]-[10] (already applied) by clearing those fields
    //   - keep LUT, dehaze, clarity, sharpness, grain
    let rest = FilterSettings {
        base_simulation: "Pass-Through".into(),
        // keep:
        dehaze: settings.dehaze,
        clarity: settings.clarity,
        sharpness: settings.sharpness,
        grain_effect: settings.grain_effect.clone(),
        grain_size: settings.grain_size.clone(),
        lut_file_path: settings.lut_file_path.clone(),
        // zero everything else so CPU only runs the tail:
        ..Default::default()
    };
    crate::processing::pipeline::process_image(&after_color, &rest, lut)
}

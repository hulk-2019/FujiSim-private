//! GPU compute pipeline for the color flow.
//!
//! Owns a single [`context::GpuContext`] for the process. See
//! `docs/superpowers/specs/2026-05-25-webgpu-pipeline-design.md` for the design.

pub mod context;
pub mod curves_bake;
pub mod lut_cache;
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

/// Full GPU pipeline: color_fused → lut3d → dehaze(CPU) → sharpen → grain → readback.
pub fn process_image_gpu(
    gpu: &context::GpuContext,
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    settings: &FilterSettings,
    lut: Option<&Lut3D>,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    if lut.is_none() && settings.is_identity() {
        return Ok(src.clone());
    }
    let (w, h) = src.dimensions();

    // 1. Upload + color_fused.
    let in_tex = upload::upload_rgb16_as_rgba16f(gpu, src, "src")?;
    let mut current = passes::color_fused::dispatch(gpu, &in_tex, settings, w, h)?;

    // 2. lut3d (if any).
    if let (Some(cpu_lut), Some(path)) = (lut, settings.lut_file_path.as_ref()) {
        let lut_tex = gpu.pipelines.lut_cache.get_or_upload(gpu, path, cpu_lut)?;
        current = passes::lut3d::dispatch(gpu, &current, &lut_tex, w, h)?;
    }

    // 3. dehaze (GPU pipeline — no CPU detour).
    if settings.dehaze != 0 {
        current = passes::dehaze::dispatch(gpu, &current, settings.dehaze, w, h)?;
    }

    // 4. sharpen (clarity + sharpness in one merge step).
    let res_scale = ((w.max(h) as f32) / 1920.0).max(1.0);
    let need_sharpen = settings.clarity != 0 || settings.sharpness != 0;
    if need_sharpen {
        let cr = ((8.0 * res_scale).round() as i32).max(1);
        let sr = ((2.0 * res_scale).round() as i32).max(1);
        current = passes::sharpen::dispatch(
            gpu,
            &current,
            &passes::sharpen::SharpenArgs {
                width: w,
                height: h,
                clarity_amount: settings.clarity as f32 / 100.0,
                clarity_radius: cr,
                sharpness_amount: settings.sharpness as f32 / 100.0,
                sharpness_radius: sr,
            },
        )?;
    }

    // 5. grain.
    let grain_strength =
        crate::processing::grain::GrainStrength::parse(settings.grain_effect.as_deref());
    if !matches!(
        grain_strength,
        crate::processing::grain::GrainStrength::None
    ) {
        let size = crate::processing::grain::GrainSize::parse(settings.grain_size.as_deref());
        let cell = size.cell() * (res_scale.round() as u32).max(1);
        current = passes::grain::dispatch(gpu, &current, w, h, grain_strength, cell)?;
    }

    upload::readback_rgba16f_as_rgb16(gpu, &current)
}

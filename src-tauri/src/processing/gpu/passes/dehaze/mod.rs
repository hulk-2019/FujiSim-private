//! Full-GPU dehaze pipeline: eliminates the CPU detour.
//!
//! Steps: dark_channel → airlight → normalize_ia → min-blur → transmission →
//! luminance → guided_filter → apply. Only one small CPU readback (32 bytes)
//! for airlight estimation.

mod apply;
mod dark_channel;
mod guided;
pub mod pipelines;

use crate::error::Result;
use crate::processing::gpu::context::GpuContext;
use apply::{phase3_transmission, phase5_apply};
use dark_channel::{phase1_airlight, phase2_dark_ia};
use guided::{make_dummy_in, make_dummy_out, phase4_guided_filter};
use std::sync::Arc;

/// Full-GPU dehaze dispatch.
pub fn dispatch(
    gpu: &GpuContext,
    src: &wgpu::Texture,
    amount: i32,
    w: u32,
    h: u32,
) -> Result<Arc<wgpu::Texture>> {
    let p = &gpu.pipelines.dehaze;

    // Phase 1: dark channel of original + airlight estimation (submit + CPU readback)
    let (_dark_orig, ar, ag, ab) = phase1_airlight(gpu, p, src, w, h)?;

    // Allocate separate dummy textures for unused input (read-only) and output (storage) bindings
    let dummy_in = make_dummy_in(&gpu.device, w, h);
    let dummy_out = make_dummy_out(&gpu.device, w, h);

    // Phases 2-5 all go in one encoder (submitted after Phase 1 completes)
    let mut enc = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("dehaze_phase2_5"),
        });

    // Phase 2: normalize I/A + dark channel
    let dark_ia = phase2_dark_ia(gpu, p, src, w, h, ar, ag, ab, &mut enc);

    // Phase 3: transmission
    let omega = 0.95; // matches CPU dehaze
    let t_raw = phase3_transmission(gpu, p, &dark_ia, w, h, omega, &mut enc);

    // Phase 4: guided filter
    let t_filtered = phase4_guided_filter(gpu, p, src, &t_raw, w, h, &dummy_in, &dummy_out, &mut enc);

    // Phase 5: apply
    let dst = phase5_apply(gpu, p, src, &t_filtered, w, h, amount, ar, ag, ab, &mut enc);

    gpu.queue.submit(std::iter::once(enc.finish()));
    Ok(Arc::new(dst))
}

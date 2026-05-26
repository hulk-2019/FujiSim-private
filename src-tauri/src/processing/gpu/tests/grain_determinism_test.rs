//! Determinism test for grain compute pass.

use crate::processing::gpu::context::GpuContext;
use crate::processing::gpu::passes::grain;
use crate::processing::gpu::upload;
use image::{ImageBuffer, Rgb};
use std::sync::Arc;

fn try_gpu() -> Option<Arc<GpuContext>> {
    pollster::block_on(GpuContext::new()).ok().map(Arc::new)
}

#[test]
fn grain_is_deterministic_per_cell() {
    let gpu = match try_gpu() {
        Some(g) => g,
        None => {
            eprintln!("WARN: no GPU; skip");
            return;
        }
    };
    let mut img: ImageBuffer<Rgb<u16>, Vec<u16>> = ImageBuffer::new(64, 64);
    for px in img.pixels_mut() {
        *px = Rgb([32768, 32768, 32768]);
    } // mid grey
    let in_tex = upload::upload_rgb16_as_rgba16f(&gpu, &img, "grain_in").unwrap();
    let a = grain::dispatch(&gpu, &in_tex, 64, 64, 80.0, 30.0, 40.0, 50.0, 1).unwrap();
    let out_a = upload::readback_rgba16f_as_rgb16(&gpu, &a).unwrap();
    let b = grain::dispatch(&gpu, &in_tex, 64, 64, 80.0, 30.0, 40.0, 50.0, 1).unwrap();
    let out_b = upload::readback_rgba16f_as_rgb16(&gpu, &b).unwrap();
    for (pa, pb) in out_a.pixels().zip(out_b.pixels()) {
        assert_eq!(pa.0, pb.0, "grain not deterministic");
    }
}

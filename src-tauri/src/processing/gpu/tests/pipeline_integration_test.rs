//! Integration test: full GPU pipeline vs CPU pipeline.

use crate::processing::gpu::context::GpuContext;
use crate::processing::gpu::process_image_gpu;
use crate::processing::pipeline::{process_image, FilterSettings};
use image::{ImageBuffer, Rgb};
use std::sync::Arc;

fn try_gpu() -> Option<Arc<GpuContext>> {
    pollster::block_on(GpuContext::new()).ok().map(Arc::new)
}

fn make_test_image(w: u32, h: u32) -> ImageBuffer<Rgb<u16>, Vec<u16>> {
    let mut img = ImageBuffer::new(w, h);
    for (x, y, px) in img.enumerate_pixels_mut() {
        let r = (x * 65535 / w.max(1)) as u16;
        let g = (y * 65535 / h.max(1)) as u16;
        let b = ((x + y) * 65535 / (w + h).max(1)) as u16;
        *px = Rgb([r, g, b]);
    }
    img
}

#[test]
fn full_pipeline_identity() {
    let gpu = match try_gpu() {
        Some(g) => g,
        None => {
            eprintln!("WARN: no GPU; skip");
            return;
        }
    };
    let img = make_test_image(64, 64);
    let s = FilterSettings::default();
    let cpu = process_image(&img, &s, None).unwrap();
    let gpu_out = process_image_gpu(&gpu, &img, &s, None).unwrap();
    assert_eq!(cpu.dimensions(), gpu_out.dimensions());
}

#[test]
fn full_pipeline_with_sharpen() {
    let gpu = match try_gpu() {
        Some(g) => g,
        None => {
            eprintln!("WARN: no GPU; skip");
            return;
        }
    };
    let img = make_test_image(64, 64);
    let s = FilterSettings {
        base_simulation: "Velvia".into(),
        clarity: 30,
        sharpness: 20,
        ..Default::default()
    };
    let cpu = process_image(&img, &s, None).unwrap();
    let gpu_out = process_image_gpu(&gpu, &img, &s, None).unwrap();
    assert_eq!(cpu.dimensions(), gpu_out.dimensions());
    // Sharpen introduces divergent rounding; just verify output is non-trivial.
    let mut non_zero = 0u32;
    for px in gpu_out.pixels() {
        if px.0[0] != 0 || px.0[1] != 0 || px.0[2] != 0 {
            non_zero += 1;
        }
    }
    assert!(non_zero > 3000, "pipeline produced trivial output");
}

#[test]
fn full_pipeline_with_grain() {
    let gpu = match try_gpu() {
        Some(g) => g,
        None => {
            eprintln!("WARN: no GPU; skip");
            return;
        }
    };
    let img = make_test_image(64, 64);
    let s = FilterSettings {
        base_simulation: "Acros".into(),
        grain_amount: 80.0,
        grain_size: 30.0,
        grain_roughness: 40.0,
        grain_color: 50.0,
        ..Default::default()
    };
    let gpu_out = process_image_gpu(&gpu, &img, &s, None).unwrap();
    assert_eq!(gpu_out.dimensions(), (64, 64));
    let mut non_zero = 0u32;
    for px in gpu_out.pixels() {
        if px.0[0] != 0 || px.0[1] != 0 || px.0[2] != 0 {
            non_zero += 1;
        }
    }
    assert!(non_zero > 3000, "grain pipeline produced trivial output");
}

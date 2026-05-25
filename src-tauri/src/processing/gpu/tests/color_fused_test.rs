//! Numerical regression tests for color_fused compute pass vs CPU pipeline.
//!
//! Tests that GPU output matches CPU output within f16 quantization tolerance.

use crate::processing::gpu::context::GpuContext;
use crate::processing::gpu::passes::color_fused::run_color_fused_only;
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

fn point_only_settings(base: &str, exp: f32, sat: i32, hi: i32, sh: i32) -> FilterSettings {
    FilterSettings {
        base_simulation: base.into(),
        exposure: exp,
        color_saturation: sat,
        highlight_tone: hi,
        shadow_tone: sh,
        ..Default::default()
    }
}

fn max_diff_per_channel(
    a: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    b: &ImageBuffer<Rgb<u16>, Vec<u16>>,
) -> u16 {
    let mut m = 0u16;
    for ((_, _, pa), (_, _, pb)) in a.enumerate_pixels().zip(b.enumerate_pixels()) {
        for c in 0..3 {
            let d = (pa.0[c] as i32 - pb.0[c] as i32).unsigned_abs() as u16;
            if d > m {
                m = d;
            }
        }
    }
    m
}

const TOLERANCE: u16 = 320; // ~0.49% of full scale.
                            // Velvia preset with saturation=55 can produce diffs up to 310 due to f16 quantization
                            // in the curve LUT (R16Float) and cumulative rounding through the HSL saturation step.

#[test]
fn color_fused_identity() {
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
    let gpu_out = run_color_fused_only(&gpu, &img, &s).unwrap();
    let diff = max_diff_per_channel(&cpu, &gpu_out);
    assert!(
        diff <= TOLERANCE,
        "identity: max diff {diff} > tolerance {TOLERANCE}"
    );
}

#[test]
fn color_fused_velvia() {
    let gpu = match try_gpu() {
        Some(g) => g,
        None => {
            eprintln!("WARN: no GPU; skip");
            return;
        }
    };
    let img = make_test_image(64, 64);
    let s = point_only_settings("Velvia", 0.0, 0, 0, 0);
    let cpu = process_image(&img, &s, None).unwrap();
    let gpu_out = run_color_fused_only(&gpu, &img, &s).unwrap();
    let diff = max_diff_per_channel(&cpu, &gpu_out);
    assert!(
        diff <= TOLERANCE,
        "velvia: max diff {diff} > tolerance {TOLERANCE}"
    );
}

#[test]
fn color_fused_high_contrast() {
    let gpu = match try_gpu() {
        Some(g) => g,
        None => {
            eprintln!("WARN: no GPU; skip");
            return;
        }
    };
    let img = make_test_image(64, 64);
    let s = point_only_settings("Pass-Through", 0.5, 30, 50, -50);
    let cpu = process_image(&img, &s, None).unwrap();
    let gpu_out = run_color_fused_only(&gpu, &img, &s).unwrap();
    let diff = max_diff_per_channel(&cpu, &gpu_out);
    assert!(
        diff <= TOLERANCE,
        "high_contrast: max diff {diff} > tolerance {TOLERANCE}"
    );
}

#[test]
fn color_fused_monochrome() {
    let gpu = match try_gpu() {
        Some(g) => g,
        None => {
            eprintln!("WARN: no GPU; skip");
            return;
        }
    };
    let img = make_test_image(64, 64);
    let s = point_only_settings("Acros", 0.0, 0, 0, 0);
    let cpu = process_image(&img, &s, None).unwrap();
    let gpu_out = run_color_fused_only(&gpu, &img, &s).unwrap();
    let diff = max_diff_per_channel(&cpu, &gpu_out);
    assert!(
        diff <= TOLERANCE,
        "monochrome: max diff {diff} > tolerance {TOLERANCE}"
    );
}

#[test]
fn color_fused_classic_chrome_high_shadow() {
    let gpu = match try_gpu() {
        Some(g) => g,
        None => {
            eprintln!("WARN: no GPU; skip");
            return;
        }
    };
    let img = make_test_image(64, 64);
    let s = point_only_settings("Classic Chrome", -0.3, 0, 0, 60);
    let cpu = process_image(&img, &s, None).unwrap();
    let gpu_out = run_color_fused_only(&gpu, &img, &s).unwrap();
    let diff = max_diff_per_channel(&cpu, &gpu_out);
    assert!(
        diff <= TOLERANCE,
        "classic_chrome_high_shadow: max diff {diff} > tolerance {TOLERANCE}"
    );
}

#![allow(clippy::unwrap_used)]

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use fotoforge_lib::processing::gpu::context::GpuContext;
use fotoforge_lib::processing::gpu::process_image_gpu;
use fotoforge_lib::processing::pipeline::{process_image_cpu, FilterSettings};
use image::{ImageBuffer, Rgb};
use std::sync::Arc;

fn make_img(w: u32, h: u32) -> ImageBuffer<Rgb<u16>, Vec<u16>> {
    let mut img = ImageBuffer::new(w, h);
    for (x, y, px) in img.enumerate_pixels_mut() {
        *px = Rgb([
            ((x as u64 * 65535 / w as u64) as u16),
            ((y as u64 * 65535 / h as u64) as u16),
            ((((x + y) as u64 * 65535 / (w + h) as u64) / 2) as u16),
        ]);
    }
    img
}

fn bench(c: &mut Criterion) {
    let gpu = match pollster::block_on(GpuContext::new()) {
        Ok(g) => Arc::new(g),
        Err(_) => {
            eprintln!("no GPU adapter; skipping benchmarks");
            return;
        }
    };
    let settings = FilterSettings {
        base_simulation: "Velvia".into(),
        exposure: 0.2,
        contrast: 20,
        clarity: 30,
        ..Default::default()
    };
    let preview = make_img(1280, 853);
    c.bench_function("gpu_preview_1280", |b| {
        b.iter(|| {
            black_box(process_image_gpu(&gpu, &preview, &settings, None).unwrap());
        })
    });
    c.bench_function("cpu_preview_1280", |b| {
        b.iter(|| {
            black_box(process_image_cpu(&preview, &settings, None).unwrap());
        })
    });
    let big = make_img(6000, 4000);
    c.bench_function("gpu_export_6k", |b| {
        b.iter(|| {
            black_box(process_image_gpu(&gpu, &big, &settings, None).unwrap());
        })
    });
    c.bench_function("cpu_export_6k", |b| {
        b.iter(|| {
            black_box(process_image_cpu(&big, &settings, None).unwrap());
        })
    });
}

criterion_group!(benches, bench);
criterion_main!(benches);

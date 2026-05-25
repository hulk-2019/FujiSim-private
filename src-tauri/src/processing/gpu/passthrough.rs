//! End-to-end smoke test for the GPU pipeline plumbing.
//!
//! Runs a no-op compute shader that copies src → dst (rgba16f → rgba16f).
//! Used only by tests in M1; deleted in M2 once `color_fused` exists.

use crate::error::Result;
use image::{ImageBuffer, Rgb};

use super::context::GpuContext;
use super::upload;

pub fn passthrough(
    gpu: &GpuContext,
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let (w, h) = src.dimensions();
    let in_tex = upload::upload_rgb16_as_rgba16f(gpu, src, "passthrough_in")?;
    let out_tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("passthrough_out"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });

    let module = gpu
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("passthrough_shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/passthrough.wgsl").into()),
        });

    let bgl = gpu
        .device
        .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("passthrough_bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba16Float,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
            ],
        });

    let pl = gpu
        .device
        .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("passthrough_pl"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });
    let pipeline = gpu
        .device
        .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("passthrough"),
            layout: Some(&pl),
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

    let in_view = in_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let out_view = out_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("passthrough_bg"),
        layout: &bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&in_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&out_view),
            },
        ],
    });

    let mut enc = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("passthrough_enc"),
        });
    {
        let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("passthrough_cp"),
            timestamp_writes: None,
        });
        cp.set_pipeline(&pipeline);
        cp.set_bind_group(0, &bg, &[]);
        let gx = w.div_ceil(16);
        let gy = h.div_ceil(16);
        cp.dispatch_workgroups(gx, gy, 1);
    }
    gpu.queue.submit(std::iter::once(enc.finish()));

    upload::readback_rgba16f_as_rgb16(gpu, &out_tex)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn try_gpu() -> Option<Arc<GpuContext>> {
        pollster::block_on(GpuContext::new()).ok().map(Arc::new)
    }

    #[test]
    fn passthrough_preserves_within_f16() {
        let gpu = match try_gpu() {
            Some(g) => g,
            None => {
                eprintln!("WARN: no GPU; skip");
                return;
            }
        };
        let mut img: ImageBuffer<Rgb<u16>, Vec<u16>> = ImageBuffer::new(64, 64);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = Rgb([(x * 1000) as u16, (y * 1000) as u16, ((x + y) * 500) as u16]);
        }
        let out = passthrough(&gpu, &img).unwrap();
        for ((_, _, a), (_, _, b)) in img.enumerate_pixels().zip(out.enumerate_pixels()) {
            for c in 0..3 {
                let d = (a.0[c] as i32 - b.0[c] as i32).abs();
                assert!(d <= 32, "channel {c} diff {d} (a={:?} b={:?})", a.0, b.0);
            }
        }
    }
}

//! Phase 3+5: Transmission computation + final dehaze apply.

use super::dark_channel::{make_r32f, ApplyParams, TransmissionParams};
use super::pipelines::DehazePipelines;
use crate::processing::gpu::context::GpuContext;
use wgpu::util::DeviceExt;

/// Phase 3: compute raw transmission t = 1 - omega * dark(I/A).
pub(super) fn phase3_transmission(
    gpu: &GpuContext,
    p: &DehazePipelines,
    dark_ia: &wgpu::Texture,
    w: u32,
    h: u32,
    omega: f32,
    enc: &mut wgpu::CommandEncoder,
) -> wgpu::Texture {
    let wg_x = w.div_ceil(16);
    let wg_y = h.div_ceil(16);

    let t_raw = make_r32f(&gpu.device, w, h, "t_raw");
    let ubuf = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("trans_ubuf"),
            contents: bytemuck::bytes_of(&TransmissionParams {
                width: w,
                height: h,
                omega,
                _pad: 0,
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });

    let src_view = dark_ia.create_view(&wgpu::TextureViewDescriptor::default());
    let dst_view = t_raw.create_view(&wgpu::TextureViewDescriptor::default());
    let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("trans_bg"),
        layout: &p.r32_to_r32_bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&src_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&dst_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: ubuf.as_entire_binding(),
            },
        ],
    });
    let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("transmission"),
        timestamp_writes: None,
    });
    cp.set_pipeline(&p.transmission);
    cp.set_bind_group(0, &bg, &[]);
    cp.dispatch_workgroups(wg_x, wg_y, 1);

    t_raw
}

/// Phase 5: final dehaze/fog apply.
/// Returns the output Rgba16Float texture.
#[allow(clippy::too_many_arguments)]
pub(super) fn phase5_apply(
    gpu: &GpuContext,
    p: &DehazePipelines,
    src: &wgpu::Texture,
    t_filtered: &wgpu::Texture,
    w: u32,
    h: u32,
    amount: i32,
    ar: f32,
    ag: f32,
    ab: f32,
    enc: &mut wgpu::CommandEncoder,
) -> wgpu::Texture {
    let wg_x = w.div_ceil(16);
    let wg_y = h.div_ceil(16);

    let dst = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("dehaze_dst"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });

    let ubuf = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("apply_ubuf"),
            contents: bytemuck::bytes_of(&ApplyParams {
                width: w,
                height: h,
                amount: amount as f32,
                ar,
                ag,
                ab,
                _p1: 0,
                _p2: 0,
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });

    let src_view = src.create_view(&wgpu::TextureViewDescriptor::default());
    let t_view = t_filtered.create_view(&wgpu::TextureViewDescriptor::default());
    let dst_view = dst.create_view(&wgpu::TextureViewDescriptor::default());
    let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("apply_bg"),
        layout: &p.apply_bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&src_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&t_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::TextureView(&dst_view),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: ubuf.as_entire_binding(),
            },
        ],
    });
    let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("dehaze_apply"),
        timestamp_writes: None,
    });
    cp.set_pipeline(&p.dehaze_apply);
    cp.set_bind_group(0, &bg, &[]);
    cp.dispatch_workgroups(wg_x, wg_y, 1);

    dst
}

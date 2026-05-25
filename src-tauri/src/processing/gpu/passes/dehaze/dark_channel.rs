//! Phase 1+2: Dark channel computation + airlight estimation.

use super::pipelines::DehazePipelines;
use crate::error::{AppError, Result};
use crate::processing::gpu::context::GpuContext;
use wgpu::util::DeviceExt;

pub(super) fn make_r32f(device: &wgpu::Device, w: u32, h: u32, label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
        view_formats: &[],
    })
}

/// Dispatch a pass that shares the `rgba_to_r32` BGL pattern:
/// [0] src texture (rgba16f or r32f), [1] dst r32f storage, [2] uniform.
#[allow(clippy::too_many_arguments)]
fn dispatch_rgba_to_r32(
    gpu: &GpuContext,
    pipeline: &wgpu::ComputePipeline,
    bgl: &wgpu::BindGroupLayout,
    src: &wgpu::Texture,
    dst: &wgpu::Texture,
    ubuf: &wgpu::Buffer,
    enc: &mut wgpu::CommandEncoder,
    wg_x: u32,
    wg_y: u32,
    label: &str,
) {
    let src_view = src.create_view(&wgpu::TextureViewDescriptor::default());
    let dst_view = dst.create_view(&wgpu::TextureViewDescriptor::default());
    let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some(label),
        layout: bgl,
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
        label: Some(label),
        timestamp_writes: None,
    });
    cp.set_pipeline(pipeline);
    cp.set_bind_group(0, &bg, &[]);
    cp.dispatch_workgroups(wg_x, wg_y, 1);
}

/// Dispatch a pass that shares the `r32_to_r32` BGL pattern:
/// [0] src r32f texture, [1] dst r32f storage, [2] uniform.
#[allow(clippy::too_many_arguments)]
fn dispatch_r32_to_r32(
    gpu: &GpuContext,
    pipeline: &wgpu::ComputePipeline,
    bgl: &wgpu::BindGroupLayout,
    src: &wgpu::Texture,
    dst: &wgpu::Texture,
    ubuf: &wgpu::Buffer,
    enc: &mut wgpu::CommandEncoder,
    wg_x: u32,
    wg_y: u32,
    label: &str,
) {
    // Same layout as rgba_to_r32, just different texture format at binding 0
    dispatch_rgba_to_r32(gpu, pipeline, bgl, src, dst, ubuf, enc, wg_x, wg_y, label)
}

/// Separable blur pair: horizontal then vertical.
#[allow(clippy::too_many_arguments)]
pub(super) fn blur_r32_pair(
    gpu: &GpuContext,
    h_pipe: &wgpu::ComputePipeline,
    v_pipe: &wgpu::ComputePipeline,
    bgl: &wgpu::BindGroupLayout,
    src: &wgpu::Texture,
    mid: &wgpu::Texture,
    dst: &wgpu::Texture,
    radius: i32,
    w: u32,
    h: u32,
    wg_x: u32,
    wg_y: u32,
    enc: &mut wgpu::CommandEncoder,
    tag: &str,
) {
    let ubuf = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(tag),
            contents: bytemuck::bytes_of(&BlurParams {
                width: w,
                height: h,
                radius,
                _pad: 0,
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
    dispatch_r32_to_r32(
        gpu,
        h_pipe,
        bgl,
        src,
        mid,
        &ubuf,
        enc,
        wg_x,
        wg_y,
        &format!("{tag}_h"),
    );
    dispatch_r32_to_r32(
        gpu,
        v_pipe,
        bgl,
        mid,
        dst,
        &ubuf,
        enc,
        wg_x,
        wg_y,
        &format!("{tag}_v"),
    );
}

// ── Uniform structs ──

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct SizeParams {
    pub width: u32,
    pub height: u32,
    pub _p1: u32,
    pub _p2: u32,
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct BlurParams {
    pub width: u32,
    pub height: u32,
    pub radius: i32,
    pub _pad: u32,
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct NormalizeParams {
    pub width: u32,
    pub height: u32,
    pub ar: f32,
    pub ag: f32,
    pub ab: f32,
    pub _p1: u32,
    pub _p2: u32,
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct TransmissionParams {
    pub width: u32,
    pub height: u32,
    pub omega: f32,
    pub _pad: u32,
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct GuidedParams {
    pub width: u32,
    pub height: u32,
    pub mode: u32,
    pub eps: f32,
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct ApplyParams {
    pub width: u32,
    pub height: u32,
    pub amount: f32,
    pub ar: f32,
    pub ag: f32,
    pub ab: f32,
    pub _p1: u32,
    pub _p2: u32,
}

pub(super) const PATCH_RADIUS: i32 = 7;
pub(super) const GF_RADIUS: i32 = 20;

/// Run Phase 1: dark channel of original + airlight estimation.
/// Returns (dark_orig texture, airlight (ar, ag, ab)).
/// The encoder is submitted + CPU readback happens inside this function.
pub(super) fn phase1_airlight(
    gpu: &GpuContext,
    p: &DehazePipelines,
    src: &wgpu::Texture,
    w: u32,
    h: u32,
) -> Result<(wgpu::Texture, f32, f32, f32)> {
    let wg_x = w.div_ceil(16);
    let wg_y = h.div_ceil(16);

    let dark_raw = make_r32f(&gpu.device, w, h, "dark_raw");
    let dark_h = make_r32f(&gpu.device, w, h, "dark_h_orig");
    let dark_orig = make_r32f(&gpu.device, w, h, "dark_orig");

    // Airlight buffers
    let airlight_buf = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("airlight_buf"),
            contents: &[0u8; 32],
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        });
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("airlight_staging"),
        size: 32,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let size_ubuf = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("dehaze_size_ubuf"),
            contents: bytemuck::bytes_of(&SizeParams {
                width: w,
                height: h,
                _p1: 0,
                _p2: 0,
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });

    let mut enc = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("dehaze_phase1"),
        });

    // Step 1: per-pixel min(R,G,B)
    dispatch_rgba_to_r32(
        gpu,
        &p.dark_channel_min,
        &p.rgba_to_r32_bgl,
        src,
        &dark_raw,
        &size_ubuf,
        &mut enc,
        wg_x,
        wg_y,
        "dark_min",
    );

    // Steps 2-3: separable min-blur (radius=7)
    blur_r32_pair(
        gpu,
        &p.box_blur_min_h,
        &p.box_blur_min_v,
        &p.r32_to_r32_bgl,
        &dark_raw,
        &dark_h,
        &dark_orig,
        PATCH_RADIUS,
        w,
        h,
        wg_x,
        wg_y,
        &mut enc,
        "dc_min_blur",
    );

    // Step 4: airlight atomic reduce
    dispatch_airlight_main(
        gpu,
        p,
        &dark_orig,
        src,
        &airlight_buf,
        &size_ubuf,
        &mut enc,
        wg_x,
        wg_y,
    );

    // Step 5: airlight read_rgb (1x1x1 workgroup)
    dispatch_airlight_read_rgb(gpu, p, src, &dark_orig, &airlight_buf, &size_ubuf, &mut enc);

    // Copy airlight result to staging buffer for CPU readback
    enc.copy_buffer_to_buffer(&airlight_buf, 0, &staging, 0, 32);

    gpu.queue.submit(std::iter::once(enc.finish()));

    // CPU readback
    let (ar, ag, ab) = readback_airlight(gpu, &staging);

    Ok((dark_orig, ar, ag, ab))
}

/// Run Phase 2: normalize I/A + min, then blur to get dark channel of I/A.
/// Returns the dark_channel_ia texture.
#[allow(clippy::too_many_arguments)]
pub(super) fn phase2_dark_ia(
    gpu: &GpuContext,
    p: &DehazePipelines,
    src: &wgpu::Texture,
    w: u32,
    h: u32,
    ar: f32,
    ag: f32,
    ab: f32,
    enc: &mut wgpu::CommandEncoder,
) -> wgpu::Texture {
    let wg_x = w.div_ceil(16);
    let wg_y = h.div_ceil(16);

    let dark_ia_min = make_r32f(&gpu.device, w, h, "dark_ia_min");
    let dark_ia_h = make_r32f(&gpu.device, w, h, "dark_ia_h");
    let dark_ia = make_r32f(&gpu.device, w, h, "dark_ia");

    let norm_ubuf = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("norm_ia_ubuf"),
            contents: bytemuck::bytes_of(&NormalizeParams {
                width: w,
                height: h,
                ar,
                ag,
                ab,
                _p1: 0,
                _p2: 0,
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });

    dispatch_rgba_to_r32(
        gpu,
        &p.normalize_ia_min,
        &p.rgba_to_r32_bgl,
        src,
        &dark_ia_min,
        &norm_ubuf,
        enc,
        wg_x,
        wg_y,
        "norm_ia_min",
    );

    blur_r32_pair(
        gpu,
        &p.box_blur_min_h,
        &p.box_blur_min_v,
        &p.r32_to_r32_bgl,
        &dark_ia_min,
        &dark_ia_h,
        &dark_ia,
        PATCH_RADIUS,
        w,
        h,
        wg_x,
        wg_y,
        enc,
        "ia_min_blur",
    );

    dark_ia
}

// ── Airlight dispatch helpers ──

#[allow(clippy::too_many_arguments)]
fn dispatch_airlight_main(
    gpu: &GpuContext,
    p: &DehazePipelines,
    dark: &wgpu::Texture,
    src: &wgpu::Texture,
    buf: &wgpu::Buffer,
    ubuf: &wgpu::Buffer,
    enc: &mut wgpu::CommandEncoder,
    wg_x: u32,
    wg_y: u32,
) {
    let dark_view = dark.create_view(&wgpu::TextureViewDescriptor::default());
    let src_view = src.create_view(&wgpu::TextureViewDescriptor::default());
    let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("airlight_main_bg"),
        layout: &p.airlight_bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&dark_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&src_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: ubuf.as_entire_binding(),
            },
        ],
    });
    let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("airlight_main"),
        timestamp_writes: None,
    });
    cp.set_pipeline(&p.airlight_main);
    cp.set_bind_group(0, &bg, &[]);
    cp.dispatch_workgroups(wg_x, wg_y, 1);
}

#[allow(clippy::too_many_arguments)]
fn dispatch_airlight_read_rgb(
    gpu: &GpuContext,
    p: &DehazePipelines,
    src: &wgpu::Texture,
    dark: &wgpu::Texture,
    buf: &wgpu::Buffer,
    ubuf: &wgpu::Buffer,
    enc: &mut wgpu::CommandEncoder,
) {
    let dark_view = dark.create_view(&wgpu::TextureViewDescriptor::default());
    let src_view = src.create_view(&wgpu::TextureViewDescriptor::default());
    let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("airlight_read_rgb_bg"),
        layout: &p.airlight_bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&dark_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&src_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: ubuf.as_entire_binding(),
            },
        ],
    });
    let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("airlight_read_rgb"),
        timestamp_writes: None,
    });
    cp.set_pipeline(&p.airlight_read_rgb);
    cp.set_bind_group(0, &bg, &[]);
    cp.dispatch_workgroups(1, 1, 1);
}

fn readback_airlight(gpu: &GpuContext, staging: &wgpu::Buffer) -> (f32, f32, f32) {
    let slice = staging.slice(..32);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    gpu.device.poll(wgpu::Maintain::Wait);
    rx.recv()
        .map_err(|e| AppError::other(format!("airlight recv: {e}")))
        .and_then(|r| r.map_err(|e| AppError::other(format!("airlight map: {e:?}"))))
        .expect("airlight readback failed");
    let data = slice.get_mapped_range();
    let u32s: &[u32] = bytemuck::cast_slice(&data);
    let ar = f32::from_bits(u32s[4]);
    let ag = f32::from_bits(u32s[5]);
    let ab = f32::from_bits(u32s[6]);
    drop(data);
    staging.unmap();
    (ar, ag, ab)
}

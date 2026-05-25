//! Phase 4: Guided filter on t_raw with guide=luminance.

use super::dark_channel::{blur_r32_pair, make_r32f, GuidedParams, SizeParams, GF_RADIUS};
use super::pipelines::DehazePipelines;
use crate::processing::gpu::context::GpuContext;
use wgpu::util::DeviceExt;

/// Create a dummy R32Float texture for unused **input** (read-only) bindings.
/// Only TEXTURE_BINDING — no STORAGE_BINDING — so it never conflicts with output writes.
pub(super) fn make_dummy_in(device: &wgpu::Device, w: u32, h: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("dummy_in"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

/// Create a dummy R32Float texture for unused **output** (write-only storage) bindings.
/// Only STORAGE_BINDING — no TEXTURE_BINDING — so it never conflicts with input reads.
pub(super) fn make_dummy_out(device: &wgpu::Device, w: u32, h: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("dummy_out"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R32Float,
        usage: wgpu::TextureUsages::STORAGE_BINDING,
        view_formats: &[],
    })
}

/// Dispatch guided_elements with specified mode.
/// Bindings: [0-3] input r32f textures, [4-5] output r32f storage, [6] uniform.
/// Unused inputs use `dummy_in` (TEXTURE_BINDING only).
/// Unused outputs use `dummy_out` (STORAGE_BINDING only).
/// This avoids the wgpu "conflicting usages" panic from binding the same
/// texture as both RESOURCE and STORAGE_READ_WRITE in one dispatch.
#[allow(clippy::too_many_arguments)]
fn dispatch_guided(
    gpu: &GpuContext,
    p: &DehazePipelines,
    in0: &wgpu::Texture,
    in1: &wgpu::Texture,
    in2: &wgpu::Texture,
    in3: &wgpu::Texture,
    out0: &wgpu::Texture,
    out1: &wgpu::Texture,
    mode: u32,
    w: u32,
    h: u32,
    enc: &mut wgpu::CommandEncoder,
    wg_x: u32,
    wg_y: u32,
    label: &str,
) {
    let v0 = in0.create_view(&wgpu::TextureViewDescriptor::default());
    let v1 = in1.create_view(&wgpu::TextureViewDescriptor::default());
    let v2 = in2.create_view(&wgpu::TextureViewDescriptor::default());
    let v3 = in3.create_view(&wgpu::TextureViewDescriptor::default());
    let o0 = out0.create_view(&wgpu::TextureViewDescriptor::default());
    let o1 = out1.create_view(&wgpu::TextureViewDescriptor::default());

    let ubuf = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: bytemuck::bytes_of(&GuidedParams {
                width: w,
                height: h,
                mode,
                eps: 0.001, // guided filter epsilon
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });

    let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some(label),
        layout: &p.guided_bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&v0),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&v1),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::TextureView(&v2),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: wgpu::BindingResource::TextureView(&v3),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: wgpu::BindingResource::TextureView(&o0),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: wgpu::BindingResource::TextureView(&o1),
            },
            wgpu::BindGroupEntry {
                binding: 6,
                resource: ubuf.as_entire_binding(),
            },
        ],
    });
    let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some(label),
        timestamp_writes: None,
    });
    cp.set_pipeline(&p.guided_elements);
    cp.set_bind_group(0, &bg, &[]);
    cp.dispatch_workgroups(wg_x, wg_y, 1);
}

/// Run Phase 4: guided filter on t_raw with guide=luminance.
/// Returns the filtered transmission (t_filtered) texture.
#[allow(clippy::too_many_arguments)]
pub(super) fn phase4_guided_filter(
    gpu: &GpuContext,
    p: &DehazePipelines,
    src: &wgpu::Texture,
    t_raw: &wgpu::Texture,
    w: u32,
    h: u32,
    dummy_in: &wgpu::Texture,  // read-only filler for unused input slots
    dummy_out: &wgpu::Texture, // write-only filler for unused output slots
    enc: &mut wgpu::CommandEncoder,
) -> wgpu::Texture {
    let wg_x = w.div_ceil(16);
    let wg_y = h.div_ceil(16);

    // Step 11: luminance
    let lum = make_r32f(&gpu.device, w, h, "lum");
    let lum_ubuf = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("lum_ubuf"),
            contents: bytemuck::bytes_of(&SizeParams {
                width: w,
                height: h,
                _p1: 0,
                _p2: 0,
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
    // Reuse rgba_to_r32 BGL for luminance (same layout: src texture + dst r32f + uniform)
    {
        let src_view = src.create_view(&wgpu::TextureViewDescriptor::default());
        let lum_view = lum.create_view(&wgpu::TextureViewDescriptor::default());
        let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("lum_bg"),
            layout: &p.rgba_to_r32_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&src_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&lum_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: lum_ubuf.as_entire_binding(),
                },
            ],
        });
        let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("lum"),
            timestamp_writes: None,
        });
        cp.set_pipeline(&p.luminance);
        cp.set_bind_group(0, &bg, &[]);
        cp.dispatch_workgroups(wg_x, wg_y, 1);
    }

    // Step 12: ip = guide * p (mode 0)
    // in: lum, t_raw — unused: in2=dummy_in, in3=dummy_in
    // out: ip — unused: out1=dummy_out
    let ip = make_r32f(&gpu.device, w, h, "ip");
    dispatch_guided(
        gpu,
        p,
        &lum,
        t_raw,
        dummy_in,
        dummy_in,
        &ip,
        dummy_out,
        0,
        w,
        h,
        enc,
        wg_x,
        wg_y,
        "guided_ip",
    );

    // Step 13: ii = guide^2 (mode 1)
    // in: lum — unused: in1=dummy_in, in2=dummy_in, in3=dummy_in
    // out: ii — unused: out1=dummy_out
    let ii = make_r32f(&gpu.device, w, h, "ii");
    dispatch_guided(
        gpu,
        p,
        &lum,
        dummy_in,
        dummy_in,
        dummy_in,
        &ii,
        dummy_out,
        1,
        w,
        h,
        enc,
        wg_x,
        wg_y,
        "guided_ii",
    );

    // Blur pairs for guided filter (radius=20)
    let ip_h = make_r32f(&gpu.device, w, h, "ip_h");
    let mean_ip = make_r32f(&gpu.device, w, h, "mean_ip");
    blur_r32_pair(
        gpu,
        &p.box_blur_mean_h,
        &p.box_blur_mean_v,
        &p.r32_to_r32_bgl,
        &ip,
        &ip_h,
        &mean_ip,
        GF_RADIUS,
        w,
        h,
        wg_x,
        wg_y,
        enc,
        "mean_ip",
    );

    let ii_h = make_r32f(&gpu.device, w, h, "ii_h");
    let mean_ii = make_r32f(&gpu.device, w, h, "mean_ii");
    blur_r32_pair(
        gpu,
        &p.box_blur_mean_h,
        &p.box_blur_mean_v,
        &p.r32_to_r32_bgl,
        &ii,
        &ii_h,
        &mean_ii,
        GF_RADIUS,
        w,
        h,
        wg_x,
        wg_y,
        enc,
        "mean_ii",
    );

    let lum_h = make_r32f(&gpu.device, w, h, "lum_h");
    let mean_lum = make_r32f(&gpu.device, w, h, "mean_lum");
    blur_r32_pair(
        gpu,
        &p.box_blur_mean_h,
        &p.box_blur_mean_v,
        &p.r32_to_r32_bgl,
        &lum,
        &lum_h,
        &mean_lum,
        GF_RADIUS,
        w,
        h,
        wg_x,
        wg_y,
        enc,
        "mean_lum",
    );

    let t_h = make_r32f(&gpu.device, w, h, "t_h");
    let mean_t = make_r32f(&gpu.device, w, h, "mean_t");
    blur_r32_pair(
        gpu,
        &p.box_blur_mean_h,
        &p.box_blur_mean_v,
        &p.r32_to_r32_bgl,
        t_raw,
        &t_h,
        &mean_t,
        GF_RADIUS,
        w,
        h,
        wg_x,
        wg_y,
        enc,
        "mean_t",
    );

    // Step 22: guided a,b (mode 2)
    let a = make_r32f(&gpu.device, w, h, "a");
    let b = make_r32f(&gpu.device, w, h, "b");
    dispatch_guided(
        gpu,
        p,
        &mean_lum,
        &mean_t,
        &mean_ip,
        &mean_ii,
        &a,
        &b,
        2,
        w,
        h,
        enc,
        wg_x,
        wg_y,
        "guided_ab",
    );

    // Blur a and b
    let a_h = make_r32f(&gpu.device, w, h, "a_h");
    let mean_a = make_r32f(&gpu.device, w, h, "mean_a");
    blur_r32_pair(
        gpu,
        &p.box_blur_mean_h,
        &p.box_blur_mean_v,
        &p.r32_to_r32_bgl,
        &a,
        &a_h,
        &mean_a,
        GF_RADIUS,
        w,
        h,
        wg_x,
        wg_y,
        enc,
        "mean_a",
    );

    let b_h = make_r32f(&gpu.device, w, h, "b_h");
    let mean_b = make_r32f(&gpu.device, w, h, "mean_b");
    blur_r32_pair(
        gpu,
        &p.box_blur_mean_h,
        &p.box_blur_mean_v,
        &p.r32_to_r32_bgl,
        &b,
        &b_h,
        &mean_b,
        GF_RADIUS,
        w,
        h,
        wg_x,
        wg_y,
        enc,
        "mean_b",
    );

    // Step 27: guided merge (mode 3)
    // in: mean_a, mean_b, lum — unused: in3=dummy_in
    // out: t_filtered — unused: out1=dummy_out
    let t_filtered = make_r32f(&gpu.device, w, h, "t_filtered");
    dispatch_guided(
        gpu,
        p,
        &mean_a,
        &mean_b,
        &lum,
        dummy_in,
        &t_filtered,
        dummy_out,
        3,
        w,
        h,
        enc,
        wg_x,
        wg_y,
        "guided_merge",
    );

    t_filtered
}

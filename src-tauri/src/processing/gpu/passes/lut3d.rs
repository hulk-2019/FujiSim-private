//! Host code for the lut3d compute pass.

use crate::error::Result;
use crate::processing::gpu::context::GpuContext;
use std::sync::Arc;
use wgpu::util::DeviceExt;

pub fn create_pipeline(
    device: &wgpu::Device,
) -> Result<(wgpu::ComputePipeline, wgpu::BindGroupLayout)> {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("lut3d_shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/lut3d.wgsl").into()),
    });
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("lut3d_bgl"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
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
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D3,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 4,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("lut3d_pl"),
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("lut3d"),
        layout: Some(&pl),
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    Ok((pipeline, bgl))
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct Dim {
    width: u32,
    height: u32,
    _pad0: u32,
    _pad1: u32,
}

pub fn dispatch(
    gpu: &GpuContext,
    src: &wgpu::Texture,
    lut: &wgpu::Texture,
    width: u32,
    height: u32,
) -> Result<Arc<wgpu::Texture>> {
    let dst = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("lut3d_dst"),
        size: wgpu::Extent3d {
            width,
            height,
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
    let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("lut3d_samp"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        address_mode_w: wgpu::AddressMode::ClampToEdge,
        ..Default::default()
    });
    let dim = Dim {
        width,
        height,
        _pad0: 0,
        _pad1: 0,
    };
    let ubuf = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("lut3d_dim"),
            contents: bytemuck::bytes_of(&dim),
            usage: wgpu::BufferUsages::UNIFORM,
        });
    let src_view = src.create_view(&wgpu::TextureViewDescriptor::default());
    let dst_view = dst.create_view(&wgpu::TextureViewDescriptor::default());
    let lut_view = lut.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D3),
        ..Default::default()
    });
    let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("lut3d_bg"),
        layout: &gpu.pipelines.lut3d_bgl,
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
                resource: wgpu::BindingResource::TextureView(&lut_view),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: ubuf.as_entire_binding(),
            },
        ],
    });

    let mut enc = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("lut3d_enc"),
        });
    {
        let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("lut3d_cp"),
            timestamp_writes: None,
        });
        cp.set_pipeline(&gpu.pipelines.lut3d);
        cp.set_bind_group(0, &bg, &[]);
        let gx = width.div_ceil(16);
        let gy = height.div_ceil(16);
        cp.dispatch_workgroups(gx, gy, 1);
    }
    gpu.queue.submit(std::iter::once(enc.finish()));
    Ok(Arc::new(dst))
}

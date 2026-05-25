//! Host code for the color_fused compute pass (steps [1]-[10]).

use crate::error::Result;
use crate::processing::gpu::context::GpuContext;
use crate::processing::gpu::curves_bake::{self, LUT_LEN};
use crate::processing::gpu::uniforms::FilterUniforms;
use crate::processing::gpu::upload;
use crate::processing::pipeline::FilterSettings;
use image::{ImageBuffer, Rgb};
use std::sync::Arc;
use wgpu::util::DeviceExt;

pub fn create_pipeline(
    device: &wgpu::Device,
) -> Result<(wgpu::ComputePipeline, wgpu::BindGroupLayout)> {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("color_fused_shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/color_fused.wgsl").into()),
    });

    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("color_fused_bgl"),
        entries: &[
            // 0: src texture
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
            // 1: dst storage texture
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
            // 2: uniforms
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            // 3: curve_lut texture (1024 × 4, r16float)
            wgpu::BindGroupLayoutEntry {
                binding: 3,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            // 4: linear sampler
            wgpu::BindGroupLayoutEntry {
                binding: 4,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    });

    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("color_fused_pl"),
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("color_fused"),
        layout: Some(&pl),
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    Ok((pipeline, bgl))
}

/// Run color_fused on `src` and return a freshly allocated rgba16f output texture.
pub fn dispatch(
    gpu: &GpuContext,
    src: &wgpu::Texture,
    settings: &FilterSettings,
    width: u32,
    height: u32,
) -> Result<Arc<wgpu::Texture>> {
    // 1. Bake tone curves → 1024 × 4 r16float texture.
    let lut_data = curves_bake::bake(settings);
    let curve_tex = upload_curve_lut(gpu, &lut_data)?;

    // 2. Build uniform buffer.
    let uniforms = FilterUniforms::from_settings(settings, width, height);
    let ubuf = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("color_fused_ubuf"),
            contents: bytemuck::bytes_of(&uniforms),
            usage: wgpu::BufferUsages::UNIFORM,
        });

    // 3. Allocate destination.
    let dst = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("color_fused_dst"),
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

    // 4. Sampler.
    let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("color_fused_samp"),
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });

    let src_view = src.create_view(&wgpu::TextureViewDescriptor::default());
    let dst_view = dst.create_view(&wgpu::TextureViewDescriptor::default());
    let curve_view = curve_tex.create_view(&wgpu::TextureViewDescriptor::default());

    let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("color_fused_bg"),
        layout: &gpu.pipelines.color_fused_bgl,
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
            wgpu::BindGroupEntry {
                binding: 3,
                resource: wgpu::BindingResource::TextureView(&curve_view),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
        ],
    });

    let mut enc = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("color_fused_enc"),
        });
    {
        let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("color_fused_cp"),
            timestamp_writes: None,
        });
        cp.set_pipeline(&gpu.pipelines.color_fused);
        cp.set_bind_group(0, &bg, &[]);
        let gx = width.div_ceil(16);
        let gy = height.div_ceil(16);
        cp.dispatch_workgroups(gx, gy, 1);
    }
    gpu.queue.submit(std::iter::once(enc.finish()));
    Ok(Arc::new(dst))
}

fn upload_curve_lut(gpu: &GpuContext, lut: &[Vec<f32>; 4]) -> Result<wgpu::Texture> {
    let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("curve_lut"),
        size: wgpu::Extent3d {
            width: LUT_LEN as u32,
            height: 4,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    // Convert 4 × LUT_LEN f32 → row-major u16 (f16 bits).
    let mut data: Vec<u16> = vec![0u16; LUT_LEN * 4];
    for (row, lut_row) in lut.iter().enumerate() {
        for (i, &v) in lut_row.iter().enumerate() {
            data[row * LUT_LEN + i] = upload::f32_to_f16_bits(v);
        }
    }
    let bytes: &[u8] = bytemuck::cast_slice(&data);
    gpu.queue.write_texture(
        wgpu::ImageCopyTexture {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        bytes,
        wgpu::ImageDataLayout {
            offset: 0,
            bytes_per_row: Some((LUT_LEN as u32) * 2),
            rows_per_image: Some(4),
        },
        wgpu::Extent3d {
            width: LUT_LEN as u32,
            height: 4,
            depth_or_array_layers: 1,
        },
    );
    Ok(tex)
}

/// Convenience for tests / driver code: full upload → dispatch → readback path.
pub fn run_color_fused_only(
    gpu: &GpuContext,
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    settings: &FilterSettings,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let (w, h) = src.dimensions();
    let in_tex = upload::upload_rgb16_as_rgba16f(gpu, src, "color_fused_src")?;
    let out = dispatch(gpu, &in_tex, settings, w, h)?;
    upload::readback_rgba16f_as_rgb16(gpu, &out)
}

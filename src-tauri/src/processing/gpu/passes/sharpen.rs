//! Host code for box blur and sharpen compute passes.

use crate::error::Result;
use crate::processing::gpu::context::GpuContext;
use std::sync::Arc;
use wgpu::util::DeviceExt;

pub struct SharpenPipelines {
    pub bh: wgpu::ComputePipeline,
    pub bh_bgl: wgpu::BindGroupLayout,
    pub bv: wgpu::ComputePipeline,
    pub bv_bgl: wgpu::BindGroupLayout,
    pub merge: wgpu::ComputePipeline,
    pub merge_bgl: wgpu::BindGroupLayout,
}

pub fn create_pipelines(device: &wgpu::Device) -> Result<SharpenPipelines> {
    let bh = compile(
        device,
        "box_blur_h",
        include_str!("../shaders/box_blur_h.wgsl"),
    );
    let bv = compile(
        device,
        "box_blur_v",
        include_str!("../shaders/box_blur_v.wgsl"),
    );
    let merge = compile_merge(device);
    Ok(SharpenPipelines {
        bh: bh.0,
        bh_bgl: bh.1,
        bv: bv.0,
        bv_bgl: bv.1,
        merge: merge.0,
        merge_bgl: merge.1,
    })
}

fn compile(
    device: &wgpu::Device,
    label: &str,
    src: &str,
) -> (wgpu::ComputePipeline, wgpu::BindGroupLayout) {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(src.into()),
    });
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some(label),
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
        ],
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(label),
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: Some(&pl),
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    (pipeline, bgl)
}

fn compile_merge(device: &wgpu::Device) -> (wgpu::ComputePipeline, wgpu::BindGroupLayout) {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("sharpen_merge"),
        source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/sharpen.wgsl").into()),
    });
    let entries = [
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
        wgpu::BindGroupLayoutEntry {
            binding: 2,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 3,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
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
    ];
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("sharpen_merge_bgl"),
        entries: &entries,
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("sharpen_merge_pl"),
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("sharpen_merge"),
        layout: Some(&pl),
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    (pipeline, bgl)
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct BlurParams {
    width: u32,
    height: u32,
    radius: i32,
    _pad: u32,
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct MergeParams {
    width: u32,
    height: u32,
    clarity_amount: f32,
    sharpness_amount: f32,
}

/// Parameters for the sharpen dispatch.
pub struct SharpenArgs {
    pub width: u32,
    pub height: u32,
    pub clarity_amount: f32,
    pub clarity_radius: i32,
    pub sharpness_amount: f32,
    pub sharpness_radius: i32,
}

pub fn dispatch(
    gpu: &GpuContext,
    src: &wgpu::Texture,
    args: &SharpenArgs,
) -> Result<Arc<wgpu::Texture>> {
    let width = args.width;
    let height = args.height;
    let make_lum = |label: &str| {
        gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
    };
    let tmp_h_clar = make_lum("tmp_h_clar");
    let blur_clar = make_lum("blur_clar");
    let tmp_h_sharp = make_lum("tmp_h_sharp");
    let blur_sharp = make_lum("blur_sharp");

    let make_ubuf = |radius: i32, label: &str| {
        gpu.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::bytes_of(&BlurParams {
                    width,
                    height,
                    radius,
                    _pad: 0,
                }),
                usage: wgpu::BufferUsages::UNIFORM,
            })
    };

    let p = &gpu.pipelines.sharpen;

    let mut enc = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("sharpen_enc"),
        });

    let do_blur = |enc: &mut wgpu::CommandEncoder,
                   src_view: &wgpu::TextureView,
                   mid_tex: &wgpu::Texture,
                   out_tex: &wgpu::Texture,
                   radius: i32,
                   tag: &str| {
        let ubuf = make_ubuf(radius, tag);
        let mid_view = mid_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let bg_h = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(tag),
            layout: &p.bh_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(src_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&mid_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: ubuf.as_entire_binding(),
                },
            ],
        });
        {
            let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some(tag),
                timestamp_writes: None,
            });
            cp.set_pipeline(&p.bh);
            cp.set_bind_group(0, &bg_h, &[]);
            cp.dispatch_workgroups(width.div_ceil(16), height.div_ceil(16), 1);
        }
        let out_view = out_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let bg_v = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(tag),
            layout: &p.bv_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&mid_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&out_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: ubuf.as_entire_binding(),
                },
            ],
        });
        {
            let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some(tag),
                timestamp_writes: None,
            });
            cp.set_pipeline(&p.bv);
            cp.set_bind_group(0, &bg_v, &[]);
            cp.dispatch_workgroups(width.div_ceil(16), height.div_ceil(16), 1);
        }
    };

    let src_view = src.create_view(&wgpu::TextureViewDescriptor::default());
    do_blur(
        &mut enc,
        &src_view,
        &tmp_h_clar,
        &blur_clar,
        args.clarity_radius,
        "clarity_blur",
    );
    do_blur(
        &mut enc,
        &src_view,
        &tmp_h_sharp,
        &blur_sharp,
        args.sharpness_radius,
        "sharp_blur",
    );

    // Merge step.
    let dst = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("sharpen_dst"),
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
    let dst_view = dst.create_view(&wgpu::TextureViewDescriptor::default());
    let blur_clar_view = blur_clar.create_view(&wgpu::TextureViewDescriptor::default());
    let blur_sharp_view = blur_sharp.create_view(&wgpu::TextureViewDescriptor::default());
    let mp = MergeParams {
        width,
        height,
        clarity_amount: args.clarity_amount,
        sharpness_amount: args.sharpness_amount,
    };
    let mubuf = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("merge_ubuf"),
            contents: bytemuck::bytes_of(&mp),
            usage: wgpu::BufferUsages::UNIFORM,
        });
    let bg_m = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("sharpen_merge_bg"),
        layout: &p.merge_bgl,
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
                resource: wgpu::BindingResource::TextureView(&blur_clar_view),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: wgpu::BindingResource::TextureView(&blur_sharp_view),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: mubuf.as_entire_binding(),
            },
        ],
    });
    {
        let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("sharpen_merge_cp"),
            timestamp_writes: None,
        });
        cp.set_pipeline(&p.merge);
        cp.set_bind_group(0, &bg_m, &[]);
        cp.dispatch_workgroups(width.div_ceil(16), height.div_ceil(16), 1);
    }

    gpu.queue.submit(std::iter::once(enc.finish()));
    Ok(Arc::new(dst))
}

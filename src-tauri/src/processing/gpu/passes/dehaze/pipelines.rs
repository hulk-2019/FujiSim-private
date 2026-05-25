//! Dehaze pipeline creation: all sub-pipelines and bind group layouts.

use crate::error::Result;

// ── Top-level struct ──

pub struct DehazePipelines {
    // Shared BGLs (5 layouts)
    pub rgba_to_r32_bgl: wgpu::BindGroupLayout,
    pub r32_to_r32_bgl: wgpu::BindGroupLayout,
    pub airlight_bgl: wgpu::BindGroupLayout,
    pub guided_bgl: wgpu::BindGroupLayout,
    pub apply_bgl: wgpu::BindGroupLayout,

    // Pipelines using rgba_to_r32 BGL
    pub dark_channel_min: wgpu::ComputePipeline,
    pub normalize_ia_min: wgpu::ComputePipeline,
    pub luminance: wgpu::ComputePipeline,

    // Pipelines using r32_to_r32 BGL
    pub box_blur_min_h: wgpu::ComputePipeline,
    pub box_blur_min_v: wgpu::ComputePipeline,
    pub box_blur_mean_h: wgpu::ComputePipeline,
    pub box_blur_mean_v: wgpu::ComputePipeline,
    pub transmission: wgpu::ComputePipeline,

    // Airlight (two entry points, same BGL)
    pub airlight_main: wgpu::ComputePipeline,
    pub airlight_read_rgb: wgpu::ComputePipeline,

    // Guided elements
    pub guided_elements: wgpu::ComputePipeline,

    // Apply
    pub dehaze_apply: wgpu::ComputePipeline,
}

// ── Shader sources ──

macro_rules! shader {
    ($name:literal) => {
        include_str!(concat!("../../shaders/", $name, ".wgsl"))
    };
}

// ── BGL builders ──

fn bgl_rgba_to_r32(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("dehaze_rgba_to_r32"),
        entries: &[tex_binding(0), storage_r32_binding(1), uniform_binding(2)],
    })
}

fn bgl_r32_to_r32(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("dehaze_r32_to_r32"),
        entries: &[tex_binding(0), storage_r32_binding(1), uniform_binding(2)],
    })
}

fn bgl_airlight(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("dehaze_airlight"),
        entries: &[
            tex_binding(0), // dark r32f
            tex_binding(1), // src rgba16f
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: Some(std::num::NonZeroU64::new(32).unwrap()),
                },
                count: None,
            },
            uniform_binding(3),
        ],
    })
}

fn bgl_guided(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("dehaze_guided"),
        entries: &[
            tex_binding(0),
            tex_binding(1),
            tex_binding(2),
            tex_binding(3),
            storage_r32_binding(4),
            storage_r32_binding(5),
            uniform_binding(6),
        ],
    })
}

fn bgl_apply(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("dehaze_apply"),
        entries: &[
            tex_binding(0), // src rgba16f
            tex_binding(1), // t r32f
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba16Float,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
                count: None,
            },
            uniform_binding(3),
        ],
    })
}

// ── Binding helpers ──

fn tex_binding(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn storage_r32_binding(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::StorageTexture {
            access: wgpu::StorageTextureAccess::WriteOnly,
            format: wgpu::TextureFormat::R32Float,
            view_dimension: wgpu::TextureViewDimension::D2,
        },
        count: None,
    }
}

fn uniform_binding(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

// ── Compile helper ──

fn compile(
    device: &wgpu::Device,
    label: &str,
    src: &str,
    bgl: &wgpu::BindGroupLayout,
    entry: &str,
) -> wgpu::ComputePipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(src.into()),
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(label),
        bind_group_layouts: &[bgl],
        push_constant_ranges: &[],
    });
    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: Some(&pl),
        module: &module,
        entry_point: Some(entry),
        compilation_options: Default::default(),
        cache: None,
    })
}

// ── Public creation ──

pub fn create_pipelines(device: &wgpu::Device) -> Result<DehazePipelines> {
    let rgba_to_r32_bgl = bgl_rgba_to_r32(device);
    let r32_to_r32_bgl = bgl_r32_to_r32(device);
    let airlight_bgl = bgl_airlight(device);
    let guided_bgl = bgl_guided(device);
    let apply_bgl = bgl_apply(device);

    Ok(DehazePipelines {
        dark_channel_min: compile(
            device,
            "dark_channel_min",
            shader!("dark_channel_min"),
            &rgba_to_r32_bgl,
            "main",
        ),
        normalize_ia_min: compile(
            device,
            "normalize_ia_min",
            shader!("normalize_ia_min"),
            &rgba_to_r32_bgl,
            "main",
        ),
        luminance: compile(
            device,
            "luminance",
            shader!("luminance"),
            &rgba_to_r32_bgl,
            "main",
        ),

        box_blur_min_h: compile(
            device,
            "box_blur_min_h",
            shader!("box_blur_min_h"),
            &r32_to_r32_bgl,
            "main",
        ),
        box_blur_min_v: compile(
            device,
            "box_blur_min_v",
            shader!("box_blur_min_v"),
            &r32_to_r32_bgl,
            "main",
        ),
        box_blur_mean_h: compile(
            device,
            "box_blur_mean_h",
            shader!("box_blur_mean_h"),
            &r32_to_r32_bgl,
            "main",
        ),
        box_blur_mean_v: compile(
            device,
            "box_blur_mean_v",
            shader!("box_blur_mean_v"),
            &r32_to_r32_bgl,
            "main",
        ),
        transmission: compile(
            device,
            "transmission",
            shader!("transmission"),
            &r32_to_r32_bgl,
            "main",
        ),

        airlight_main: compile(
            device,
            "airlight_main",
            shader!("dehaze_airlight"),
            &airlight_bgl,
            "main",
        ),
        airlight_read_rgb: compile(
            device,
            "airlight_read_rgb",
            shader!("dehaze_airlight"),
            &airlight_bgl,
            "read_rgb",
        ),

        guided_elements: compile(
            device,
            "guided_elements",
            shader!("guided_elements"),
            &guided_bgl,
            "main",
        ),
        dehaze_apply: compile(
            device,
            "dehaze_apply",
            shader!("dehaze_apply"),
            &apply_bgl,
            "main",
        ),

        rgba_to_r32_bgl,
        r32_to_r32_bgl,
        airlight_bgl,
        guided_bgl,
        apply_bgl,
    })
}

//! GPU device + queue + pipeline cache.

use crate::error::{AppError, Result};

pub struct Pipelines {
    pub color_fused: wgpu::ComputePipeline,
    pub color_fused_bgl: wgpu::BindGroupLayout,
    pub lut3d: wgpu::ComputePipeline,
    pub lut3d_bgl: wgpu::BindGroupLayout,
    pub lut_cache: super::lut_cache::GpuLutCache,
    pub sharpen: super::passes::sharpen::SharpenPipelines,
    pub grain: wgpu::ComputePipeline,
    pub grain_bgl: wgpu::BindGroupLayout,
}

pub struct GpuContext {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub pipelines: Pipelines,
}

impl GpuContext {
    pub async fn new() -> Result<Self> {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .ok_or_else(|| AppError::other("no GPU adapter found"))?;

        let info = adapter.get_info();
        tracing::info!(
            backend = ?info.backend,
            name = %info.name,
            device_type = ?info.device_type,
            "GPU adapter selected"
        );

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("fujisim_device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::default(),
                    memory_hints: wgpu::MemoryHints::Performance,
                },
                None,
            )
            .await
            .map_err(|e| AppError::other(format!("request_device: {e}")))?;

        let (color_fused, color_fused_bgl) = super::passes::color_fused::create_pipeline(&device)?;
        let (lut3d, lut3d_bgl) = super::passes::lut3d::create_pipeline(&device)?;
        let sharpen = super::passes::sharpen::create_pipelines(&device)?;
        let (grain, grain_bgl) = super::passes::grain::create_pipeline(&device)?;

        Ok(Self {
            device,
            queue,
            pipelines: Pipelines {
                color_fused,
                color_fused_bgl,
                lut3d,
                lut3d_bgl,
                lut_cache: Default::default(),
                sharpen,
                grain,
                grain_bgl,
            },
        })
    }
}

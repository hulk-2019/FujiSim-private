//! GPU-side cache mapping `.cube` LUT path → uploaded 3D rgba16f texture.

use crate::error::Result;
use crate::processing::gpu::context::GpuContext;
use crate::processing::gpu::upload;
use crate::processing::lut::Lut3D;
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct GpuLutCache {
    map: Mutex<HashMap<PathBuf, Arc<wgpu::Texture>>>,
}

impl GpuLutCache {
    pub fn get_or_upload(
        &self,
        gpu: &GpuContext,
        path: &Path,
        cpu_lut: &Lut3D,
    ) -> Result<Arc<wgpu::Texture>> {
        let mut map = self.map.lock().unwrap();
        match map.entry(path.to_path_buf()) {
            Entry::Occupied(e) => Ok(e.get().clone()),
            Entry::Vacant(e) => {
                let tex = Arc::new(upload_lut3d(gpu, cpu_lut)?);
                e.insert(tex.clone());
                Ok(tex)
            }
        }
    }

    pub fn evict(&self, path: &Path) {
        self.map.lock().unwrap().remove(path);
    }
}

fn upload_lut3d(gpu: &GpuContext, lut: &Lut3D) -> Result<wgpu::Texture> {
    let n = lut.size as u32;
    let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("lut3d"),
        size: wgpu::Extent3d {
            width: n,
            height: n,
            depth_or_array_layers: n,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    // Pack: lut.data is Vec<f32> with RGB triplets in BGR-major order
    // (blue outermost, per .cube file convention).
    // Each texel is 4 × f16 (rgba). Total texels = n³.
    let total = (n * n * n) as usize;
    let mut buf = vec![0u16; total * 4];
    for i in 0..total {
        // Lut3D stores RGB triplets: data[i*3], data[i*3+1], data[i*3+2]
        let r = lut.data[i * 3];
        let g = lut.data[i * 3 + 1];
        let b = lut.data[i * 3 + 2];
        buf[i * 4] = upload::f32_to_f16_bits(r);
        buf[i * 4 + 1] = upload::f32_to_f16_bits(g);
        buf[i * 4 + 2] = upload::f32_to_f16_bits(b);
        buf[i * 4 + 3] = upload::f32_to_f16_bits(1.0);
    }
    let bytes: &[u8] = bytemuck::cast_slice(&buf);
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
            bytes_per_row: Some(n * 8),
            rows_per_image: Some(n),
        },
        wgpu::Extent3d {
            width: n,
            height: n,
            depth_or_array_layers: n,
        },
    );
    Ok(tex)
}

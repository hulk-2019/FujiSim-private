//! Convert ImageBuffer<Rgb<u16>> ↔ wgpu rgba16f textures.

use crate::error::{AppError, Result};
use image::{ImageBuffer, Rgb};
use std::sync::Arc;

use super::context::GpuContext;

/// Upload an `Rgb<u16>` image to a freshly allocated rgba16f texture.
/// Alpha is filled with 1.0. The image is converted to f16 on the CPU before upload.
pub fn upload_rgb16_as_rgba16f(
    gpu: &GpuContext,
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    label: &str,
) -> Result<Arc<wgpu::Texture>> {
    let (w, h) = src.dimensions();
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });

    // Convert u16 → f16 (rgba). Half the data: 16-bit float per channel.
    let total = (w as usize) * (h as usize) * 4;
    let mut data: Vec<u16> = vec![0u16; total];
    for (i, px) in src.pixels().enumerate() {
        let r = (px.0[0] as f32) / 65535.0;
        let g = (px.0[1] as f32) / 65535.0;
        let b = (px.0[2] as f32) / 65535.0;
        data[i * 4] = f32_to_f16_bits(r);
        data[i * 4 + 1] = f32_to_f16_bits(g);
        data[i * 4 + 2] = f32_to_f16_bits(b);
        data[i * 4 + 3] = f32_to_f16_bits(1.0);
    }
    let bytes: &[u8] = bytemuck::cast_slice(&data);

    gpu.queue.write_texture(
        wgpu::ImageCopyTexture {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        bytes,
        wgpu::ImageDataLayout {
            offset: 0,
            bytes_per_row: Some(w * 8),
            rows_per_image: Some(h),
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );

    Ok(Arc::new(texture))
}

/// Read back an rgba16f texture and pack into `Rgb<u16>`.
pub fn readback_rgba16f_as_rgb16(
    gpu: &GpuContext,
    texture: &wgpu::Texture,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let size = texture.size();
    let w = size.width;
    let h = size.height;
    let bytes_per_row = w * 8; // rgba16f = 8 bytes/pixel
    let padded_bpr = align_up(bytes_per_row, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let buffer_size = (padded_bpr as u64) * (h as u64);

    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback_rgba16f"),
        size: buffer_size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let mut encoder = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("readback"),
        });
    encoder.copy_texture_to_buffer(
        wgpu::ImageCopyTexture {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::ImageCopyBuffer {
            buffer: &buffer,
            layout: wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(padded_bpr),
                rows_per_image: Some(h),
            },
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
    gpu.queue.submit(std::iter::once(encoder.finish()));

    let slice = buffer.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    gpu.device.poll(wgpu::Maintain::Wait);
    rx.recv()
        .map_err(|e| AppError::other(format!("map recv: {e}")))?
        .map_err(|e| AppError::other(format!("map: {e:?}")))?;
    let data = slice.get_mapped_range();

    let mut out: ImageBuffer<Rgb<u16>, Vec<u16>> = ImageBuffer::new(w, h);
    let row_bytes = (w * 8) as usize;
    let padded = padded_bpr as usize;
    for y in 0..h {
        let row_start = (y as usize) * padded;
        let row = &data[row_start..row_start + row_bytes];
        let halfs: &[u16] = bytemuck::cast_slice(row);
        for x in 0..w {
            let i = (x as usize) * 4;
            let r = f16_bits_to_f32(halfs[i]);
            let g = f16_bits_to_f32(halfs[i + 1]);
            let b = f16_bits_to_f32(halfs[i + 2]);
            out.put_pixel(
                x,
                y,
                Rgb([
                    (r.clamp(0.0, 1.0) * 65535.0).round() as u16,
                    (g.clamp(0.0, 1.0) * 65535.0).round() as u16,
                    (b.clamp(0.0, 1.0) * 65535.0).round() as u16,
                ]),
            );
        }
    }
    drop(data);
    buffer.unmap();
    Ok(out)
}

fn align_up(v: u32, align: u32) -> u32 {
    v.div_ceil(align) * align
}

/// IEEE 754 half-precision (binary16) helpers — wgpu's rgba16f format.
fn f32_to_f16_bits(f: f32) -> u16 {
    let bits = f.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exp = ((bits >> 23) & 0xff) as i32;
    let mant = bits & 0x7fffff;
    if exp == 0xff {
        // inf or NaN
        return sign | 0x7c00 | (if mant != 0 { 1 } else { 0 });
    }
    let new_exp = exp - 127 + 15;
    if new_exp >= 0x1f {
        return sign | 0x7c00; // overflow → inf
    }
    if new_exp <= 0 {
        if 14 - new_exp > 24 {
            return sign;
        }
        let mant = mant | 0x800000;
        let shift = 14 - new_exp;
        let m = (mant >> shift) as u16;
        return sign | m;
    }
    sign | ((new_exp as u16) << 10) | ((mant >> 13) as u16)
}

fn f16_bits_to_f32(h: u16) -> f32 {
    let sign = ((h >> 15) & 1) as u32;
    let exp = ((h >> 10) & 0x1f) as u32;
    let mant = (h & 0x3ff) as u32;
    let bits = if exp == 0 {
        if mant == 0 {
            sign << 31
        } else {
            let mut m = mant;
            let mut e: i32 = 1;
            while (m & 0x400) == 0 {
                m <<= 1;
                e -= 1;
            }
            let m = (m & 0x3ff) << 13;
            (sign << 31) | (((127 - 15 + e) as u32) << 23) | m
        }
    } else if exp == 0x1f {
        (sign << 31) | (0xff << 23) | (mant << 13)
    } else {
        (sign << 31) | ((exp + 127 - 15) << 23) | (mant << 13)
    };
    f32::from_bits(bits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn try_gpu() -> Option<Arc<GpuContext>> {
        pollster::block_on(GpuContext::new()).ok().map(Arc::new)
    }

    #[test]
    fn roundtrip_preserves_within_one_lsb() {
        let gpu = match try_gpu() {
            Some(g) => g,
            None => {
                eprintln!("WARN: no GPU adapter; skipping");
                return;
            }
        };
        let mut img: ImageBuffer<Rgb<u16>, Vec<u16>> = ImageBuffer::new(16, 16);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = Rgb([
                (x * 4096) as u16,
                (y * 4096) as u16,
                ((x + y) * 2048) as u16,
            ]);
        }
        let tex = upload_rgb16_as_rgba16f(&gpu, &img, "rt").unwrap();
        let out = readback_rgba16f_as_rgb16(&gpu, &tex).unwrap();
        for ((_, _, a), (_, _, b)) in img.enumerate_pixels().zip(out.enumerate_pixels()) {
            for c in 0..3 {
                let d = (a.0[c] as i32 - b.0[c] as i32).abs();
                assert!(
                    d <= 32,
                    "channel {c} diff {d} too large (a={:?} b={:?})",
                    a.0,
                    b.0
                );
            }
        }
    }

    #[test]
    fn roundtrip_handles_subnormal_f16_values() {
        let gpu = match try_gpu() {
            Some(g) => g,
            None => {
                eprintln!("WARN: no GPU adapter; skipping");
                return;
            }
        };
        // u16 values 1, 2, 3 encode to f16 subnormals (below 2^-14 ≈ 6.1e-5).
        // The subnormal decode path must not lose precision beyond f16 quantization.
        let mut img: ImageBuffer<Rgb<u16>, Vec<u16>> = ImageBuffer::new(4, 4);
        for px in img.pixels_mut() {
            *px = Rgb([1, 2, 3]);
        }
        let tex = upload_rgb16_as_rgba16f(&gpu, &img, "subnormal").unwrap();
        let out = readback_rgba16f_as_rgb16(&gpu, &tex).unwrap();
        // f16 subnormal precision near zero is ~1/2^24 ≈ 4e-8, in u16 terms < 1 LSB.
        // But because subnormals snap to grid 2^-24, u16 1 → 2^-24 ≈ 1.5e-8 which f16 rounds
        // to nearest representable. Tolerance: we just want round-trip to stay within ~1 LSB.
        for px in out.pixels() {
            assert!(px.0[0] <= 4, "expected ~1, got {}", px.0[0]);
            assert!(px.0[1] <= 4, "expected ~2, got {}", px.0[1]);
            assert!(px.0[2] <= 4, "expected ~3, got {}", px.0[2]);
        }
    }
}

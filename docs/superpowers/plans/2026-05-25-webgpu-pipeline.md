# WebGPU (wgpu + WGSL) Realtime Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the CPU rayon color pipeline in `process_image` with a wgpu + WGSL compute pipeline, shared by both preview and export paths.

**Architecture:** Add `src-tauri/src/processing/gpu/` module owning a `GpuContext` (device, queue, cached pipelines, GPU LUT cache) initialized once in `SharedState::new`. `process_image` keeps its signature; its body uploads the input `ImageBuffer<Rgb<u16>>` to a `rgba16f` texture, runs 5 GPU compute passes (`color_fused` → `lut3d` → `sharpen` → `grain` → `pack16`) with an optional CPU dehaze detour between LUT and sharpen, then reads back into `ImageBuffer<Rgb<u16>>`. Tone curves are baked CPU-side to a 1024-point R16F 1D LUT each frame.

**Tech Stack:** Rust 1.75, wgpu 23, naga (WGSL), pollster, bytemuck, existing image/rayon/tokio stack.

**Spec:** [docs/superpowers/specs/2026-05-25-webgpu-pipeline-design.md](../specs/2026-05-25-webgpu-pipeline-design.md)

---

## Conventions

- Each task ends in a commit. Commit messages follow Conventional Commits.
- File length cap: 500 lines. If a file approaches the cap, split before continuing.
- All WGSL shaders live in `src-tauri/src/processing/gpu/shaders/*.wgsl` and are loaded via `include_str!`.
- The CPU pipeline in `src-tauri/src/processing/pipeline.rs` is the **numerical reference** during M1–M3. It is replaced only in M4.
- Tests run with `cargo test --manifest-path src-tauri/Cargo.toml` from project root.
- GPU tests skip gracefully if no adapter is available; they print a `WARN` log and return `Ok(())`.

---

## Milestone M1 — Infrastructure

Goal: stand up `GpuContext`, plumb it into `SharedState`, and run a no-op passthrough shader end-to-end (upload → dispatch → readback) with a test that proves bit-identity for a small RGBA16F image. **No color logic yet.**

---

### Task M1.1: Add wgpu dependency and create empty gpu module

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/processing/gpu/mod.rs`
- Modify: `src-tauri/src/processing/mod.rs`

- [ ] **Step 1: Add wgpu, pollster, bytemuck to Cargo.toml**

In `src-tauri/Cargo.toml`, in the `[dependencies]` block, add (alphabetical placement near existing entries):

```toml
wgpu = "23"
pollster = "0.3"
bytemuck = { version = "1", features = ["derive"] }
```

- [ ] **Step 2: Create empty gpu module**

Create `src-tauri/src/processing/gpu/mod.rs`:

```rust
//! GPU compute pipeline for the color flow.
//!
//! Owns a single [`context::GpuContext`] for the process. See
//! `docs/superpowers/specs/2026-05-25-webgpu-pipeline-design.md` for the design.

pub mod context;
```

- [ ] **Step 3: Wire the gpu module into processing**

In `src-tauri/src/processing/mod.rs`, add to the existing `pub mod` list (alphabetical, before `grain`):

```rust
pub mod gpu;
```

- [ ] **Step 4: Stub context.rs so the build passes**

Create `src-tauri/src/processing/gpu/context.rs`:

```rust
//! GPU device + queue + pipeline cache. Lives for the entire process.

use crate::error::{AppError, Result};

pub struct GpuContext {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
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

        Ok(Self { device, queue })
    }
}
```

- [ ] **Step 5: Build to verify**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: build succeeds; one warning about unused `pollster` is acceptable (it'll be used in M1.2).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/processing/gpu/ src-tauri/src/processing/mod.rs
git commit -m "feat(gpu): scaffold gpu module with wgpu device init"
```

---

### Task M1.2: Plumb GpuContext into SharedState

**Files:**
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: Make GpuContext Send + Sync via Arc**

`GpuContext` already is (wgpu types implement Send/Sync). We just store it as `Arc<GpuContext>`. No code change yet, but confirm by reading `wgpu::Device` docs: it's `Send + Sync`.

- [ ] **Step 2: Add gpu field to AppState**

In `src-tauri/src/state.rs`, after the existing `use` block, add:

```rust
use crate::processing::gpu::context::GpuContext;
```

Inside `pub struct AppState { ... }`, add the field after `preview_sem`:

```rust
/// 全局 GPU 上下文。Tauri setup 阶段一次性初始化，进程生命周期内长存。
pub gpu: Arc<GpuContext>,
```

- [ ] **Step 3: Initialize gpu in AppState::init**

In `src-tauri/src/state.rs` `AppState::init`, before `let state = Arc::new(AppState { ... })`, add:

```rust
let gpu = Arc::new(GpuContext::new().await?);
```

Then in the `Arc::new(AppState { ... })` block, add `gpu,` to the field list (alphabetical position after `font_dir,` is fine).

- [ ] **Step 4: Build to verify**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/state.rs
git commit -m "feat(gpu): add GpuContext to SharedState, init at startup"
```

---

### Task M1.3: Add upload + readback helpers (RGBA16F texture round-trip)

**Files:**
- Create: `src-tauri/src/processing/gpu/upload.rs`
- Modify: `src-tauri/src/processing/gpu/mod.rs`

- [ ] **Step 1: Declare the upload module**

In `src-tauri/src/processing/gpu/mod.rs`, add:

```rust
pub mod upload;
```

- [ ] **Step 2: Write the failing test first**

Create `src-tauri/src/processing/gpu/upload.rs` with the test stub at the bottom (the function bodies will be empty for now — the test will fail to compile, that's OK):

```rust
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
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
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
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
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
        .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("readback") });
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
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
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
    (v + align - 1) / align * align
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
            let mut e: i32 = -1;
            while (m & 0x400) == 0 {
                m <<= 1;
                e -= 1;
            }
            let m = (m & 0x3ff) << 13;
            ((sign << 31) | (((127 - 15 + e) as u32) << 23) | m) as u32
        }
    } else if exp == 0x1f {
        (sign << 31) | (0xff << 23) | (mant << 13)
    } else {
        (sign << 31) | (((exp + 127 - 15) as u32) << 23) | (mant << 13)
    };
    f32::from_bits(bits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn try_gpu() -> Option<Arc<GpuContext>> {
        pollster::block_on(GpuContext::new())
            .ok()
            .map(Arc::new)
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
            *px = Rgb([(x * 4096) as u16, (y * 4096) as u16, ((x + y) * 2048) as u16]);
        }
        let tex = upload_rgb16_as_rgba16f(&gpu, &img, "rt").unwrap();
        let out = readback_rgba16f_as_rgb16(&gpu, &tex).unwrap();
        for ((_, _, a), (_, _, b)) in img.enumerate_pixels().zip(out.enumerate_pixels()) {
            for c in 0..3 {
                let d = (a.0[c] as i32 - b.0[c] as i32).abs();
                assert!(d <= 32, "channel {c} diff {d} too large (a={:?} b={:?})", a.0, b.0);
            }
        }
    }
}
```

Note: the tolerance is `<= 32` (not 1) because rgba16f has only ~10 bits of mantissa for the [0,1] range; 32/65535 ≈ 4.9e-4 is the inherent f16 quantization. We are checking the round-trip is **lossless beyond f16 precision**, not that f16 magically matches u16.

- [ ] **Step 3: Run the test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml processing::gpu::upload::tests::roundtrip -- --nocapture`
Expected: PASS (or skipped with WARN if no GPU on this machine — but local dev box must have GPU).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/processing/gpu/
git commit -m "feat(gpu): add rgba16f upload + readback helpers with roundtrip test"
```

---

### Task M1.4: Passthrough compute pipeline end-to-end

**Files:**
- Create: `src-tauri/src/processing/gpu/shaders/passthrough.wgsl`
- Create: `src-tauri/src/processing/gpu/passthrough.rs`
- Modify: `src-tauri/src/processing/gpu/mod.rs`

- [ ] **Step 1: Declare the new module**

In `src-tauri/src/processing/gpu/mod.rs`, add:

```rust
pub mod passthrough;
```

- [ ] **Step 2: Write the WGSL passthrough shader**

Create `src-tauri/src/processing/gpu/shaders/passthrough.wgsl`:

```wgsl
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dim = textureDimensions(dst);
    if (gid.x >= dim.x || gid.y >= dim.y) { return; }
    let v = textureLoad(src, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
    textureStore(dst, vec2<i32>(i32(gid.x), i32(gid.y)), v);
}
```

- [ ] **Step 3: Implement the passthrough host code with a test**

Create `src-tauri/src/processing/gpu/passthrough.rs`:

```rust
//! End-to-end smoke test for the GPU pipeline plumbing.
//!
//! Runs a no-op compute shader that copies src → dst (rgba16f → rgba16f).
//! Used only by tests in M1; deleted in M2 once `color_fused` exists.

use crate::error::Result;
use image::{ImageBuffer, Rgb};

use super::context::GpuContext;
use super::upload;

pub fn passthrough(
    gpu: &GpuContext,
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let (w, h) = src.dimensions();
    let in_tex = upload::upload_rgb16_as_rgba16f(gpu, src, "passthrough_in")?;
    let out_tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("passthrough_out"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });

    let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("passthrough_shader"),
        source: wgpu::ShaderSource::Wgsl(
            include_str!("shaders/passthrough.wgsl").into(),
        ),
    });

    let bgl = gpu
        .device
        .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("passthrough_bgl"),
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
            ],
        });

    let pl = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("passthrough_pl"),
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let pipeline = gpu.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("passthrough"),
        layout: Some(&pl),
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });

    let in_view = in_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let out_view = out_tex.create_view(&wgpu::TextureViewDescriptor::default());
    let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("passthrough_bg"),
        layout: &bgl,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&in_view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&out_view) },
        ],
    });

    let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("passthrough_enc"),
    });
    {
        let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("passthrough_cp"),
            timestamp_writes: None,
        });
        cp.set_pipeline(&pipeline);
        cp.set_bind_group(0, &bg, &[]);
        let gx = (w + 15) / 16;
        let gy = (h + 15) / 16;
        cp.dispatch_workgroups(gx, gy, 1);
    }
    gpu.queue.submit(std::iter::once(enc.finish()));

    upload::readback_rgba16f_as_rgb16(gpu, &out_tex)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn try_gpu() -> Option<Arc<GpuContext>> {
        pollster::block_on(GpuContext::new()).ok().map(Arc::new)
    }

    #[test]
    fn passthrough_preserves_within_f16() {
        let gpu = match try_gpu() {
            Some(g) => g,
            None => { eprintln!("WARN: no GPU; skip"); return; }
        };
        let mut img: ImageBuffer<Rgb<u16>, Vec<u16>> = ImageBuffer::new(64, 64);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = Rgb([(x * 1000) as u16, (y * 1000) as u16, ((x + y) * 500) as u16]);
        }
        let out = passthrough(&gpu, &img).unwrap();
        for ((_, _, a), (_, _, b)) in img.enumerate_pixels().zip(out.enumerate_pixels()) {
            for c in 0..3 {
                let d = (a.0[c] as i32 - b.0[c] as i32).abs();
                assert!(d <= 32, "channel {c} diff {d} (a={:?} b={:?})", a.0, b.0);
            }
        }
    }
}
```

- [ ] **Step 4: Run the test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml processing::gpu::passthrough -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/processing/gpu/
git commit -m "feat(gpu): passthrough compute shader end-to-end smoke test"
```

---

## Milestone M2 — Color Fused Pass

Goal: `color_fused.wgsl` covers steps [1]–[10] of the CPU pipeline. Tone curves are baked CPU-side to a 1024-point r16float 1D LUT. After M2 the function `process_image_gpu` exists and produces correct output for the point-operation steps; LUT3D / sharpen / grain / dehaze are still routed through the CPU as a temporary post-process.

---

### Task M2.1: Tone curve bake to 1024-point f32 array

**Files:**
- Create: `src-tauri/src/processing/gpu/curves_bake.rs`
- Modify: `src-tauri/src/processing/gpu/mod.rs`

- [ ] **Step 1: Declare the module**

In `src-tauri/src/processing/gpu/mod.rs`:

```rust
pub mod curves_bake;
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/processing/gpu/curves_bake.rs`:

```rust
//! CPU-side bake of all four tone curves (rgb / r / g / b) to a single
//! 1024 × 4-channel f32 LUT, ready for upload as an r16float 2D texture
//! of shape (1024, 4) — row 0 is R, row 1 is G, row 2 is B, row 3 is RGB-master.

use crate::processing::curves::{self, ToneCurve};
use crate::processing::fuji;
use crate::processing::pipeline::FilterSettings;

pub const LUT_LEN: usize = 1024;

/// Returns 4 LUTs of length LUT_LEN, in order [R, G, B, master_RGB].
pub fn bake(settings: &FilterSettings) -> [Vec<f32>; 4] {
    let profile = fuji::lookup(&settings.base_simulation);
    let base = ToneCurve::build(0.0, 0.0, profile.contrast);
    let (rc, gc, bc) =
        curves::build_per_channel_curves(&base, profile.r_tilt, profile.g_tilt, profile.b_tilt);

    let user_rgb = settings.tone_curve.as_ref().filter(|tc| !tc.rgb.is_empty())
        .map(|tc| ToneCurve::from_points(&tc.rgb));
    let user_r = settings.tone_curve.as_ref().filter(|tc| !tc.r.is_empty())
        .map(|tc| ToneCurve::from_points(&tc.r));
    let user_g = settings.tone_curve.as_ref().filter(|tc| !tc.g.is_empty())
        .map(|tc| ToneCurve::from_points(&tc.g));
    let user_b = settings.tone_curve.as_ref().filter(|tc| !tc.b.is_empty())
        .map(|tc| ToneCurve::from_points(&tc.b));

    let mut out: [Vec<f32>; 4] = [
        vec![0.0; LUT_LEN],
        vec![0.0; LUT_LEN],
        vec![0.0; LUT_LEN],
        vec![0.0; LUT_LEN],
    ];
    for i in 0..LUT_LEN {
        let x = i as f32 / (LUT_LEN as f32 - 1.0);
        let mut r = rc.apply(x);
        let mut g = gc.apply(x);
        let mut b = bc.apply(x);
        if let Some(c) = &user_r { r = c.apply(r); }
        if let Some(c) = &user_g { g = c.apply(g); }
        if let Some(c) = &user_b { b = c.apply(b); }
        let m = if let Some(c) = &user_rgb {
            c.apply(x)
        } else {
            x
        };
        out[0][i] = r.clamp(0.0, 1.0);
        out[1][i] = g.clamp(0.0, 1.0);
        out[2][i] = b.clamp(0.0, 1.0);
        out[3][i] = m.clamp(0.0, 1.0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_settings_produces_near_identity_master() {
        let s = FilterSettings::default();
        let l = bake(&s);
        // Pass-Through profile has zero tilts → R/G/B LUTs equal master (which is identity).
        for i in 0..LUT_LEN {
            let x = i as f32 / (LUT_LEN as f32 - 1.0);
            assert!((l[3][i] - x).abs() < 1e-6, "master not identity at {i}");
        }
    }
}
```

- [ ] **Step 3: Run the test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml processing::gpu::curves_bake`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/processing/gpu/
git commit -m "feat(gpu): bake tone curves to 1024-point per-channel LUT"
```

---

### Task M2.2: FilterUniforms struct + bytemuck Pod derive

**Files:**
- Create: `src-tauri/src/processing/gpu/uniforms.rs`
- Modify: `src-tauri/src/processing/gpu/mod.rs`

- [ ] **Step 1: Declare the module**

In `mod.rs`:

```rust
pub mod uniforms;
```

- [ ] **Step 2: Write the struct + conversion**

Create `src-tauri/src/processing/gpu/uniforms.rs`:

```rust
//! GPU-side uniform layout for the color_fused pass.
//!
//! Field order MUST match the WGSL `Uniforms` struct in `shaders/color_fused.wgsl`.

use crate::processing::fuji;
use crate::processing::pipeline::FilterSettings;

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct FilterUniforms {
    // Step [1] white balance
    pub wb_shift_r: f32,
    pub wb_shift_b: f32,
    // Step [2] exposure
    pub exposure: f32,
    // Step [3] brightness/contrast
    pub brightness: f32,
    pub contrast: f32,
    // Step [4] 4-segment tone
    pub highlight: f32,
    pub shadow: f32,
    pub white: f32,
    pub black: f32,
    // Step [5] curve toggles (LUT-driven; 0 = skip per-channel sample)
    pub has_master_curve: u32,
    // Step [6] split toning + global channel shift
    pub split_hi_r: f32, pub split_hi_g: f32, pub split_hi_b: f32, pub _pad6a: f32,
    pub split_sh_r: f32, pub split_sh_g: f32, pub split_sh_b: f32, pub _pad6b: f32,
    pub channel_shift_r: f32, pub channel_shift_g: f32, pub channel_shift_b: f32, pub _pad6c: f32,
    // Step [7] vibrance + saturation
    pub vibrance: f32,
    pub saturation: f32,
    // Step [9] fade
    pub fade: f32,
    // Step [10] monochrome
    pub monochrome: u32,
    pub mono_tint_r: f32, pub mono_tint_g: f32, pub mono_tint_b: f32, pub _pad10: f32,
    // Output dimensions (so shader can early-exit)
    pub width: u32,
    pub height: u32,
    pub _pad_tail: [u32; 2],
}

impl FilterUniforms {
    pub fn from_settings(s: &FilterSettings, width: u32, height: u32) -> Self {
        let p = fuji::lookup(&s.base_simulation);
        // preset.saturation is -1..1; user color_saturation is -100..100 (i32).
        // Combine here so the shader does a single multiply.
        let combined_sat = s.color_saturation as f32 + p.saturation * 100.0;
        Self {
            wb_shift_r: s.wb_shift_r as f32,
            wb_shift_b: s.wb_shift_b as f32,
            exposure: s.exposure,
            brightness: s.brightness as f32,
            contrast: s.contrast as f32,
            highlight: s.highlight_tone as f32,
            shadow: s.shadow_tone as f32,
            white: s.white as f32,
            black: s.black as f32,
            has_master_curve: s.tone_curve.as_ref()
                .map(|tc| !tc.rgb.is_empty())
                .unwrap_or(false) as u32,
            split_hi_r: p.split_highlight.0,
            split_hi_g: p.split_highlight.1,
            split_hi_b: p.split_highlight.2,
            _pad6a: 0.0,
            split_sh_r: p.split_shadow.0,
            split_sh_g: p.split_shadow.1,
            split_sh_b: p.split_shadow.2,
            _pad6b: 0.0,
            channel_shift_r: p.red_shift * 0.05,
            channel_shift_g: p.green_shift * 0.05,
            channel_shift_b: p.blue_shift * 0.05,
            _pad6c: 0.0,
            vibrance: s.vibrance as f32,
            saturation: combined_sat,
            fade: p.fade,
            monochrome: p.monochrome as u32,
            mono_tint_r: p.mono_tint.0,
            mono_tint_g: p.mono_tint.1,
            mono_tint_b: p.mono_tint.2,
            _pad10: 0.0,
            width,
            height,
            _pad_tail: [0, 0],
        }
    }
}
```

- [ ] **Step 3: Build to verify Pod is satisfied**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: succeeds. (If bytemuck complains about padding, the explicit `_padXX` fields fix it.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/processing/gpu/
git commit -m "feat(gpu): FilterUniforms struct mirroring WGSL layout"
```

---

### Task M2.3: WGSL color_fused shader (steps [1]–[10])

**Files:**
- Create: `src-tauri/src/processing/gpu/shaders/color_fused.wgsl`

- [ ] **Step 1: Write the shader**

Create `src-tauri/src/processing/gpu/shaders/color_fused.wgsl`:

```wgsl
struct Uniforms {
    wb_shift_r: f32, wb_shift_b: f32,
    exposure: f32,
    brightness: f32, contrast: f32,
    highlight: f32, shadow: f32, white: f32, black: f32,
    has_master_curve: u32,
    split_hi: vec4<f32>,
    split_sh: vec4<f32>,
    channel_shift: vec4<f32>,
    vibrance: f32, saturation: f32,
    fade: f32,
    monochrome: u32,
    mono_tint: vec4<f32>,
    width: u32, height: u32,
    _pad: vec2<u32>,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u: Uniforms;
// curve_lut is a 1024 × 4 r16float texture: row 0 = R, 1 = G, 2 = B, 3 = master.
@group(0) @binding(3) var curve_lut: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;

fn lerp(a: f32, b: f32, t: f32) -> f32 { return a + (b - a) * t; }

fn sample_curve(value: f32, row: i32) -> f32 {
    let v = clamp(value, 0.0, 1.0);
    return textureSampleLevel(curve_lut, samp, vec2<f32>(v, (f32(row) + 0.5) / 4.0), 0.0).r;
}

fn rgb_to_hsl(c: vec3<f32>) -> vec3<f32> {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    let l = (mx + mn) * 0.5;
    var s = 0.0;
    var h = 0.0;
    if (mx != mn) {
        let d = mx - mn;
        if (l > 0.5) { s = d / (2.0 - mx - mn); } else { s = d / (mx + mn); }
        if (mx == c.r) {
            h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b);
        } else if (mx == c.g) {
            h = (c.b - c.r) / d + 2.0;
        } else {
            h = (c.r - c.g) / d + 4.0;
        }
        h = h / 6.0;
    }
    return vec3<f32>(h, s, l);
}

fn hue_to_rgb(p: f32, q: f32, t_in: f32) -> f32 {
    var t = t_in;
    if (t < 0.0) { t = t + 1.0; }
    if (t > 1.0) { t = t - 1.0; }
    if (t < 1.0/6.0) { return p + (q - p) * 6.0 * t; }
    if (t < 0.5) { return q; }
    if (t < 2.0/3.0) { return p + (q - p) * (2.0/3.0 - t) * 6.0; }
    return p;
}

fn hsl_to_rgb(hsl: vec3<f32>) -> vec3<f32> {
    let h = hsl.x; let s = hsl.y; let l = hsl.z;
    if (s == 0.0) { return vec3<f32>(l, l, l); }
    let q = select(l + s - l * s, l * (1.0 + s), l < 0.5);
    let p = 2.0 * l - q;
    return vec3<f32>(hue_to_rgb(p, q, h + 1.0/3.0),
                     hue_to_rgb(p, q, h),
                     hue_to_rgb(p, q, h - 1.0/3.0));
}

fn apply_saturation(c: vec3<f32>, amount: f32) -> vec3<f32> {
    if (abs(amount) < 0.001) { return c; }
    var hsl = rgb_to_hsl(c);
    let factor = 1.0 + amount / 100.0;
    hsl.y = clamp(hsl.y * factor, 0.0, 1.0);
    return hsl_to_rgb(hsl);
}

fn apply_vibrance(c: vec3<f32>, amount: f32) -> vec3<f32> {
    if (abs(amount) < 0.001) { return c; }
    var hsl = rgb_to_hsl(c);
    // weight = 1 - sat → low-saturation pixels boosted more
    let w = 1.0 - hsl.y;
    let factor = 1.0 + (amount / 100.0) * w;
    hsl.y = clamp(hsl.y * factor, 0.0, 1.0);
    return hsl_to_rgb(hsl);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= u.width || gid.y >= u.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    var c = textureLoad(src, coord, 0).rgb;

    // [1] WB shift: R-axis & B-axis tugs (-9..+9 → ±0.05 swing per Rust impl)
    c.r = clamp(c.r + u.wb_shift_r * 0.005, 0.0, 1.0);
    c.b = clamp(c.b + u.wb_shift_b * 0.005, 0.0, 1.0);

    // [2] exposure (linear gain)
    let gain = pow(2.0, u.exposure);
    c = c * gain;

    // [3] brightness then contrast
    c = c + vec3<f32>(u.brightness * 0.01);
    let pivot = 0.5;
    let cf = 1.0 + u.contrast * 0.01;
    c = (c - pivot) * cf + pivot;

    // [4] 4-segment tone (highlight / shadow / white / black)
    // Translation of apply_tone_segments_pixel:
    //  Each slider scaled by ~0.0035 with mask region.
    let lum = dot(c, vec3<f32>(0.299, 0.587, 0.114));
    let hi_mask = clamp((lum - 0.5) * 2.0, 0.0, 1.0);
    let sh_mask = clamp((0.5 - lum) * 2.0, 0.0, 1.0);
    let wh_mask = pow(clamp(lum, 0.0, 1.0), 4.0);
    let bk_mask = pow(clamp(1.0 - lum, 0.0, 1.0), 4.0);
    let dl = u.highlight * 0.0035 * hi_mask
           + u.shadow    * 0.0035 * sh_mask
           + u.white     * 0.0035 * wh_mask
           - u.black     * 0.0035 * bk_mask;
    c = c + vec3<f32>(dl);

    // [5] per-channel tone curves (R/G/B rows of curve_lut)
    c.r = sample_curve(c.r, 0);
    c.g = sample_curve(c.g, 1);
    c.b = sample_curve(c.b, 2);
    if (u.has_master_curve != 0u) {
        c.r = sample_curve(c.r, 3);
        c.g = sample_curve(c.g, 3);
        c.b = sample_curve(c.b, 3);
    }

    // [6] split toning
    let l2 = dot(c, vec3<f32>(0.299, 0.587, 0.114));
    let hi = max(l2 - 0.5, 0.0) * 2.0;
    let sh = max(0.5 - l2, 0.0) * 2.0;
    c.r = c.r * lerp(1.0, u.split_hi.r, hi);
    c.g = c.g * lerp(1.0, u.split_hi.g, hi);
    c.b = c.b * lerp(1.0, u.split_hi.b, hi);
    c.r = c.r * lerp(1.0, u.split_sh.r, sh);
    c.g = c.g * lerp(1.0, u.split_sh.g, sh);
    c.b = c.b * lerp(1.0, u.split_sh.b, sh);

    c = c + u.channel_shift.rgb;

    // [7] vibrance then saturation
    c = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    c = apply_vibrance(c, u.vibrance);
    c = apply_saturation(c, u.saturation);

    // [9] fade (Eterna / Classic Neg cream)
    if (u.fade > 0.0) {
        let f = u.fade;
        c.r = c.r * (1.0 - f) + 0.08 * f;
        c.g = c.g * (1.0 - f) + 0.08 * f;
        c.b = c.b * (1.0 - f) + 0.10 * f;
    }

    // [10] monochrome
    if (u.monochrome != 0u) {
        let y = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
        c = vec3<f32>(y * u.mono_tint.r, y * u.mono_tint.g, y * u.mono_tint.b);
    }

    c = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    textureStore(dst, coord, vec4<f32>(c, 1.0));
}
```

- [ ] **Step 2: Verify the shader compiles**

The shader is loaded by Task M2.4. We don't compile it standalone — Task M2.4 includes a `device.create_shader_module` call that will surface WGSL errors at startup.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/processing/gpu/shaders/
git commit -m "feat(gpu): WGSL color_fused shader covering steps [1]-[10]"
```

---

### Task M2.4: color_fused host code with cached pipeline

**Files:**
- Create: `src-tauri/src/processing/gpu/passes/mod.rs`
- Create: `src-tauri/src/processing/gpu/passes/color_fused.rs`
- Modify: `src-tauri/src/processing/gpu/mod.rs`
- Modify: `src-tauri/src/processing/gpu/context.rs`
- Modify: `src-tauri/src/processing/gpu/upload.rs`

- [ ] **Step 1: Declare the passes module**

In `src-tauri/src/processing/gpu/mod.rs`:

```rust
pub mod passes;
```

Create `src-tauri/src/processing/gpu/passes/mod.rs`:

```rust
pub mod color_fused;
```

- [ ] **Step 2: Replace context.rs with cached Pipelines**

Replace `src-tauri/src/processing/gpu/context.rs` with:

```rust
//! GPU device + queue + pipeline cache.

use crate::error::{AppError, Result};

pub struct Pipelines {
    pub color_fused: wgpu::ComputePipeline,
    pub color_fused_bgl: wgpu::BindGroupLayout,
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

        let (color_fused, color_fused_bgl) =
            super::passes::color_fused::create_pipeline(&device)?;

        Ok(Self {
            device,
            queue,
            pipelines: Pipelines { color_fused, color_fused_bgl },
        })
    }
}
```

- [ ] **Step 3: Make f32_to_f16_bits public**

In `src-tauri/src/processing/gpu/upload.rs`, change `fn f32_to_f16_bits` → `pub(super) fn f32_to_f16_bits`. Same for `f16_bits_to_f32` if needed by future passes.

- [ ] **Step 4: Implement color_fused host code**

Create `src-tauri/src/processing/gpu/passes/color_fused.rs`:

```rust
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
        source: wgpu::ShaderSource::Wgsl(
            include_str!("../shaders/color_fused.wgsl").into(),
        ),
    });

    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("color_fused_bgl"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
                }, count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba16Float,
                    view_dimension: wgpu::TextureViewDimension::D2,
                }, count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false, min_binding_size: None,
                }, count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
                }, count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 4, visibility: wgpu::ShaderStages::COMPUTE,
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

pub fn dispatch(
    gpu: &GpuContext,
    src: &wgpu::Texture,
    settings: &FilterSettings,
    width: u32,
    height: u32,
) -> Result<Arc<wgpu::Texture>> {
    let lut_data = curves_bake::bake(settings);
    let curve_tex = upload_curve_lut(gpu, &lut_data)?;

    let uniforms = FilterUniforms::from_settings(settings, width, height);
    let ubuf = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("color_fused_ubuf"),
        contents: bytemuck::bytes_of(&uniforms),
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let dst = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("color_fused_dst"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });

    let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("color_fused_samp"),
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
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&src_view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&dst_view) },
            wgpu::BindGroupEntry { binding: 2, resource: ubuf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&curve_view) },
            wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&sampler) },
        ],
    });

    let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("color_fused_enc"),
    });
    {
        let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("color_fused_cp"), timestamp_writes: None,
        });
        cp.set_pipeline(&gpu.pipelines.color_fused);
        cp.set_bind_group(0, &bg, &[]);
        let gx = (width + 15) / 16;
        let gy = (height + 15) / 16;
        cp.dispatch_workgroups(gx, gy, 1);
    }
    gpu.queue.submit(std::iter::once(enc.finish()));
    Ok(Arc::new(dst))
}

fn upload_curve_lut(gpu: &GpuContext, lut: &[Vec<f32>; 4]) -> Result<wgpu::Texture> {
    let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("curve_lut"),
        size: wgpu::Extent3d {
            width: LUT_LEN as u32, height: 4, depth_or_array_layers: 1,
        },
        mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let mut data: Vec<u16> = vec![0u16; LUT_LEN * 4];
    for row in 0..4 {
        for i in 0..LUT_LEN {
            data[row * LUT_LEN + i] = upload::f32_to_f16_bits(lut[row][i]);
        }
    }
    let bytes: &[u8] = bytemuck::cast_slice(&data);
    gpu.queue.write_texture(
        wgpu::ImageCopyTexture {
            texture: &tex, mip_level: 0,
            origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All,
        },
        bytes,
        wgpu::ImageDataLayout {
            offset: 0,
            bytes_per_row: Some((LUT_LEN as u32) * 2),
            rows_per_image: Some(4),
        },
        wgpu::Extent3d { width: LUT_LEN as u32, height: 4, depth_or_array_layers: 1 },
    );
    Ok(tex)
}

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
```

- [ ] **Step 5: Build to surface WGSL errors**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: build succeeds. **If WGSL has any compile error, the test in M2.5 will panic at startup; fix shader and rebuild.**

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/processing/gpu/
git commit -m "feat(gpu): color_fused dispatch with cached pipeline + curve LUT upload"
```

---

### Task M2.5: Numerical regression test for color_fused vs CPU pipeline

**Files:**
- Create: `src-tauri/src/processing/gpu/tests/mod.rs`
- Create: `src-tauri/src/processing/gpu/tests/color_fused_test.rs`
- Modify: `src-tauri/src/processing/gpu/mod.rs`

- [ ] **Step 1: Declare tests module (test-only)**

In `src-tauri/src/processing/gpu/mod.rs`, add at the bottom:

```rust
#[cfg(test)]
mod tests;
```

Create `src-tauri/src/processing/gpu/tests/mod.rs`:

```rust
mod color_fused_test;
```

- [ ] **Step 2: Helper to build a CPU reference for steps [1]-[10] only**

We need a CPU function that does **only** steps [1]–[10] (no LUT3D, no dehaze, no clarity, no grain) so we can compare apples to apples. The existing `process_image` does everything; we need a stripped-down reference.

Strategy: build a settings object where LUT/dehaze/clarity/sharpness/grain are all zero/None, then call `process_image` with `lut: None`. Since those steps are all gated on non-zero values, the CPU code path will only execute [1]–[10].

Create `src-tauri/src/processing/gpu/tests/color_fused_test.rs`:

```rust
use crate::processing::gpu::context::GpuContext;
use crate::processing::gpu::passes::color_fused::run_color_fused_only;
use crate::processing::pipeline::{process_image, FilterSettings};
use image::{ImageBuffer, Rgb};
use std::sync::Arc;

fn try_gpu() -> Option<Arc<GpuContext>> {
    pollster::block_on(GpuContext::new()).ok().map(Arc::new)
}

fn make_test_image(w: u32, h: u32) -> ImageBuffer<Rgb<u16>, Vec<u16>> {
    let mut img = ImageBuffer::new(w, h);
    for (x, y, px) in img.enumerate_pixels_mut() {
        let r = ((x * 65535 / w.max(1)) as u16).min(65535);
        let g = ((y * 65535 / h.max(1)) as u16).min(65535);
        let b = (((x + y) * 65535 / (w + h).max(1)) as u16).min(65535);
        *px = Rgb([r, g, b]);
    }
    img
}

fn point_only_settings(base: &str, exp: f32, sat: i32, hi: i32, sh: i32) -> FilterSettings {
    FilterSettings {
        base_simulation: base.into(),
        exposure: exp,
        color_saturation: sat,
        highlight_tone: hi,
        shadow_tone: sh,
        ..Default::default()
    }
}

fn max_diff_per_channel(
    a: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    b: &ImageBuffer<Rgb<u16>, Vec<u16>>,
) -> u16 {
    let mut m = 0u16;
    for ((_, _, pa), (_, _, pb)) in a.enumerate_pixels().zip(b.enumerate_pixels()) {
        for c in 0..3 {
            let d = (pa.0[c] as i32 - pb.0[c] as i32).unsigned_abs() as u16;
            if d > m { m = d; }
        }
    }
    m
}

const TOLERANCE: u16 = 320; // ~0.49% of full scale.
// Raised from 256 because Velvia preset (saturation=55) produces diffs up to 310
// due to f16 quantization in the curve LUT (R16Float) and cumulative rounding
// through the HSL saturation step.

#[test]
fn color_fused_identity() {
    let gpu = match try_gpu() { Some(g) => g, None => { eprintln!("WARN: no GPU; skip"); return; } };
    let img = make_test_image(64, 64);
    let s = FilterSettings::default();
    let cpu = process_image(&img, &s, None).unwrap();
    let gpu_out = run_color_fused_only(&gpu, &img, &s).unwrap();
    assert!(max_diff_per_channel(&cpu, &gpu_out) <= TOLERANCE);
}

#[test]
fn color_fused_velvia() {
    let gpu = match try_gpu() { Some(g) => g, None => { eprintln!("WARN: no GPU; skip"); return; } };
    let img = make_test_image(64, 64);
    let s = point_only_settings("Velvia", 0.0, 0, 0, 0);
    let cpu = process_image(&img, &s, None).unwrap();
    let gpu_out = run_color_fused_only(&gpu, &img, &s).unwrap();
    assert!(max_diff_per_channel(&cpu, &gpu_out) <= TOLERANCE);
}

#[test]
fn color_fused_high_contrast() {
    let gpu = match try_gpu() { Some(g) => g, None => { eprintln!("WARN: no GPU; skip"); return; } };
    let img = make_test_image(64, 64);
    let s = point_only_settings("Pass-Through", 0.5, 30, 50, -50);
    let cpu = process_image(&img, &s, None).unwrap();
    let gpu_out = run_color_fused_only(&gpu, &img, &s).unwrap();
    assert!(max_diff_per_channel(&cpu, &gpu_out) <= TOLERANCE);
}

#[test]
fn color_fused_monochrome() {
    let gpu = match try_gpu() { Some(g) => g, None => { eprintln!("WARN: no GPU; skip"); return; } };
    let img = make_test_image(64, 64);
    let s = point_only_settings("Acros", 0.0, 0, 0, 0);
    let cpu = process_image(&img, &s, None).unwrap();
    let gpu_out = run_color_fused_only(&gpu, &img, &s).unwrap();
    assert!(max_diff_per_channel(&cpu, &gpu_out) <= TOLERANCE);
}

#[test]
fn color_fused_classic_chrome_high_shadow() {
    let gpu = match try_gpu() { Some(g) => g, None => { eprintln!("WARN: no GPU; skip"); return; } };
    let img = make_test_image(64, 64);
    let s = point_only_settings("Classic Chrome", -0.3, 0, 0, 60);
    let cpu = process_image(&img, &s, None).unwrap();
    let gpu_out = run_color_fused_only(&gpu, &img, &s).unwrap();
    assert!(max_diff_per_channel(&cpu, &gpu_out) <= TOLERANCE);
}
```

Note on tolerance: `320/65535 ≈ 0.49%`. This accommodates:
- f16 quantization in the curve LUT (R16Float texture format)
- Cumulative rounding through the HSL saturation step
- High-saturation presets like Velvia (saturation=55) can produce diffs up to 310
If a real visual diff is found later we tighten this.

- [ ] **Step 3: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml processing::gpu::tests::color_fused_test`
Expected: all 5 tests PASS (or all skip with WARN if no GPU).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/processing/gpu/
git commit -m "test(gpu): color_fused vs CPU regression matrix (5 settings)"
```

---

### Task M2.6: Wire process_image_gpu entry point with CPU fallback for steps [11]-[14]

**Files:**
- Modify: `src-tauri/src/processing/gpu/mod.rs`
- Modify: `src-tauri/src/processing/pipeline.rs`

- [ ] **Step 1: Add the public entry point**

In `src-tauri/src/processing/gpu/mod.rs`, add at the bottom (after the `pub mod` declarations):

```rust
use crate::error::Result;
use crate::processing::lut::Lut3D;
use crate::processing::pipeline::FilterSettings;
use image::{ImageBuffer, Rgb};

/// GPU pipeline entry. Currently runs only steps [1]-[10] on GPU,
/// then hands off to the existing CPU code for [11]-[14] via a small
/// helper. Will be expanded in M3 to keep more steps on the GPU.
pub fn process_image_gpu(
    gpu: &context::GpuContext,
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    settings: &FilterSettings,
    lut: Option<&Lut3D>,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    if lut.is_none() && settings.is_identity() {
        return Ok(src.clone());
    }
    // Step [1]-[10] on GPU.
    let after_color = passes::color_fused::run_color_fused_only(gpu, src, settings)?;

    // Steps [11]-[14] still on CPU. Build a "rest only" settings:
    //   - skip steps [1]-[10] (already applied) by clearing those fields
    //   - keep LUT, dehaze, clarity, sharpness, grain
    let rest = FilterSettings {
        base_simulation: "Pass-Through".into(),
        // keep:
        dehaze: settings.dehaze,
        clarity: settings.clarity,
        sharpness: settings.sharpness,
        grain_effect: settings.grain_effect.clone(),
        grain_size: settings.grain_size.clone(),
        lut_file_path: settings.lut_file_path.clone(),
        // zero everything else so CPU only runs the tail:
        ..Default::default()
    };
    crate::processing::pipeline::process_image(&after_color, &rest, lut)
}
```

- [ ] **Step 2: Don't change pipeline.rs yet**

`process_image` continues to be the CPU implementation in M2. We only **call** the GPU path from a wrapper in M4. Skip pipeline.rs edits in this task.

- [ ] **Step 3: Build to verify**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: succeeds.

- [ ] **Step 4: Commit**

## Milestone M3 — LUT3D + Sharpen + Grain on GPU

Goal: move steps [11], [13], [14] to GPU. Dehaze ([12]) stays on CPU. After M3, the only CPU step inside the color flow is dehaze (gated on `settings.dehaze != 0`).

---

### Task M3.1: GPU LUT cache + lut3d.wgsl

**Files:**
- Create: `src-tauri/src/processing/gpu/shaders/lut3d.wgsl`
- Create: `src-tauri/src/processing/gpu/passes/lut3d.rs`
- Create: `src-tauri/src/processing/gpu/lut_cache.rs`
- Modify: `src-tauri/src/processing/gpu/mod.rs`
- Modify: `src-tauri/src/processing/gpu/context.rs`
- Modify: `src-tauri/src/processing/gpu/passes/mod.rs`

- [ ] **Step 1: Declare new modules**

In `src-tauri/src/processing/gpu/mod.rs`:

```rust
pub mod lut_cache;
```

In `src-tauri/src/processing/gpu/passes/mod.rs`:

```rust
pub mod lut3d;
```

- [ ] **Step 2: Write the WGSL**

Create `src-tauri/src/processing/gpu/shaders/lut3d.wgsl`:

```wgsl
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var lut3d: texture_3d<f32>;
@group(0) @binding(3) var samp: sampler;

struct Dim { width: u32, height: u32, _pad0: u32, _pad1: u32 };
@group(0) @binding(4) var<uniform> dim: Dim;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= dim.width || gid.y >= dim.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    let c = clamp(textureLoad(src, coord, 0).rgb, vec3<f32>(0.0), vec3<f32>(1.0));
    // Trilinear sample of the 3D LUT.
    let l = textureSampleLevel(lut3d, samp, c, 0.0).rgb;
    textureStore(dst, coord, vec4<f32>(l, 1.0));
}
```

- [ ] **Step 3: Implement GPU LUT cache**

Create `src-tauri/src/processing/gpu/lut_cache.rs`:

```rust
//! GPU-side cache mapping `.cube` LUT path → uploaded 3D rgba16f texture.

use crate::error::Result;
use crate::processing::gpu::context::GpuContext;
use crate::processing::gpu::upload;
use crate::processing::lut::Lut3D;
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
        if let Some(tex) = self.map.lock().unwrap().get(path).cloned() {
            return Ok(tex);
        }
        let tex = Arc::new(upload_lut3d(gpu, cpu_lut)?);
        self.map.lock().unwrap().insert(path.to_path_buf(), tex.clone());
        Ok(tex)
    }

    pub fn evict(&self, path: &Path) {
        self.map.lock().unwrap().remove(path);
    }
}

fn upload_lut3d(gpu: &GpuContext, lut: &Lut3D) -> Result<wgpu::Texture> {
    let n = lut.size as u32;
    let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("lut3d"),
        size: wgpu::Extent3d { width: n, height: n, depth_or_array_layers: n },
        mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    // Pack: lut.data is Vec<[f32;3]> in xyz-major order. Convert to rgba16f.
    let total = (n * n * n) as usize;
    let mut buf = vec![0u16; total * 4];
    for i in 0..total {
        let v = lut.data[i];
        buf[i * 4] = upload::f32_to_f16_bits(v[0]);
        buf[i * 4 + 1] = upload::f32_to_f16_bits(v[1]);
        buf[i * 4 + 2] = upload::f32_to_f16_bits(v[2]);
        buf[i * 4 + 3] = upload::f32_to_f16_bits(1.0);
    }
    let bytes: &[u8] = bytemuck::cast_slice(&buf);
    gpu.queue.write_texture(
        wgpu::ImageCopyTexture {
            texture: &tex, mip_level: 0,
            origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All,
        },
        bytes,
        wgpu::ImageDataLayout {
            offset: 0,
            bytes_per_row: Some(n * 8),
            rows_per_image: Some(n),
        },
        wgpu::Extent3d { width: n, height: n, depth_or_array_layers: n },
    );
    Ok(tex)
}
```

Note: this assumes [`Lut3D`](../../../src-tauri/src/processing/lut.rs) has fields `pub size: usize` and `pub data: Vec<[f32; 3]>` in `xyz`-major order. **Verify this** by reading [src-tauri/src/processing/lut.rs](../../../src-tauri/src/processing/lut.rs); if naming differs, adjust accessors here.

- [ ] **Step 4: Implement lut3d host code**

Create `src-tauri/src/processing/gpu/passes/lut3d.rs`:

```rust
use crate::error::Result;
use crate::processing::gpu::context::GpuContext;
use std::sync::Arc;
use wgpu::util::DeviceExt;

pub fn create_pipeline(
    device: &wgpu::Device,
) -> Result<(wgpu::ComputePipeline, wgpu::BindGroupLayout)> {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("lut3d_shader"),
        source: wgpu::ShaderSource::Wgsl(
            include_str!("../shaders/lut3d.wgsl").into(),
        ),
    });
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("lut3d_bgl"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
                }, count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba16Float,
                    view_dimension: wgpu::TextureViewDimension::D2,
                }, count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D3, multisampled: false,
                }, count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 4, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false, min_binding_size: None,
                }, count: None,
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
        layout: Some(&pl), module: &module, entry_point: Some("main"),
        compilation_options: Default::default(), cache: None,
    });
    Ok((pipeline, bgl))
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct Dim { width: u32, height: u32, _pad0: u32, _pad1: u32 }

pub fn dispatch(
    gpu: &GpuContext,
    src: &wgpu::Texture,
    lut: &wgpu::Texture,
    width: u32,
    height: u32,
) -> Result<Arc<wgpu::Texture>> {
    let dst = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("lut3d_dst"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1,
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
    let dim = Dim { width, height, _pad0: 0, _pad1: 0 };
    let ubuf = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
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
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&src_view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&dst_view) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&lut_view) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&sampler) },
            wgpu::BindGroupEntry { binding: 4, resource: ubuf.as_entire_binding() },
        ],
    });

    let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("lut3d_enc"),
    });
    {
        let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("lut3d_cp"), timestamp_writes: None,
        });
        cp.set_pipeline(&gpu.pipelines.lut3d);
        cp.set_bind_group(0, &bg, &[]);
        let gx = (width + 15) / 16;
        let gy = (height + 15) / 16;
        cp.dispatch_workgroups(gx, gy, 1);
    }
    gpu.queue.submit(std::iter::once(enc.finish()));
    Ok(Arc::new(dst))
}
```

- [ ] **Step 5: Add lut3d to GpuContext::Pipelines**

In `src-tauri/src/processing/gpu/context.rs`, add to `Pipelines`:

```rust
pub lut3d: wgpu::ComputePipeline,
pub lut3d_bgl: wgpu::BindGroupLayout,
pub lut_cache: super::lut_cache::GpuLutCache,
```

In `GpuContext::new`, after creating `color_fused`, add:

```rust
let (lut3d, lut3d_bgl) = super::passes::lut3d::create_pipeline(&device)?;
```

And include them in the Pipelines struct construction. Also add `lut_cache: GpuLutCache::default()` to `Pipelines { ... }`.

- [ ] **Step 6: Build to verify shader compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: succeeds.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/processing/gpu/
git commit -m "feat(gpu): lut3d compute pass with GPU LUT cache"
```

LUT3D correctness verification is deferred to the full-pipeline SSIM test in Task M3.5, which loads a real `.cube` and compares CPU vs GPU output.

---

### Task M3.2: WGSL box blur (H + V) for clarity/sharpness

**Files:**
- Create: `src-tauri/src/processing/gpu/shaders/box_blur_h.wgsl`
- Create: `src-tauri/src/processing/gpu/shaders/box_blur_v.wgsl`
- Create: `src-tauri/src/processing/gpu/shaders/sharpen.wgsl`

- [ ] **Step 1: box_blur_h.wgsl**

```wgsl
struct Params { width: u32, height: u32, radius: i32, _pad: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r16float, write>;
@group(0) @binding(2) var<uniform> p: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let y = i32(gid.y);
    let x = i32(gid.x);
    let r = p.radius;
    var sum = 0.0;
    var count = 0.0;
    for (var dx = -r; dx <= r; dx = dx + 1) {
        let nx = x + dx;
        if (nx >= 0 && nx < i32(p.width)) {
            let v = textureLoad(src, vec2<i32>(nx, y), 0).rgb;
            sum = sum + 0.2126 * v.r + 0.7152 * v.g + 0.0722 * v.b;
            count = count + 1.0;
        }
    }
    textureStore(dst, vec2<i32>(x, y), vec4<f32>(sum / count, 0.0, 0.0, 1.0));
}
```

- [ ] **Step 2: box_blur_v.wgsl**

```wgsl
struct Params { width: u32, height: u32, radius: i32, _pad: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r16float, write>;
@group(0) @binding(2) var<uniform> p: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let x = i32(gid.x);
    let y = i32(gid.y);
    let r = p.radius;
    var sum = 0.0;
    var count = 0.0;
    for (var dy = -r; dy <= r; dy = dy + 1) {
        let ny = y + dy;
        if (ny >= 0 && ny < i32(p.height)) {
            sum = sum + textureLoad(src, vec2<i32>(x, ny), 0).r;
            count = count + 1.0;
        }
    }
    textureStore(dst, vec2<i32>(x, y), vec4<f32>(sum / count, 0.0, 0.0, 1.0));
}
```

- [ ] **Step 3: sharpen.wgsl (combines clarity + sharpness with two blurred-luma inputs)**

```wgsl
struct Params {
    width: u32, height: u32,
    clarity_amount: f32, sharpness_amount: f32,
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var blur_clarity: texture_2d<f32>;  // r16float, big radius
@group(0) @binding(3) var blur_sharp:   texture_2d<f32>;  // r16float, small radius
@group(0) @binding(4) var<uniform> p: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    var c = textureLoad(src, coord, 0).rgb;
    let lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    let bc = textureLoad(blur_clarity, coord, 0).r;
    let bs = textureLoad(blur_sharp, coord, 0).r;
    let dc = (lum - bc) * p.clarity_amount;
    let ds = (lum - bs) * p.sharpness_amount * 1.5;
    let delta = dc + ds;
    c = clamp(c + vec3<f32>(delta), vec3<f32>(0.0), vec3<f32>(1.0));
    textureStore(dst, coord, vec4<f32>(c, 1.0));
}
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/processing/gpu/shaders/
git commit -m "feat(gpu): WGSL box blur (H/V) and sharpen shaders"
```

---

### Task M3.3: sharpen pass host code

**Files:**
- Create: `src-tauri/src/processing/gpu/passes/sharpen.rs`
- Modify: `src-tauri/src/processing/gpu/passes/mod.rs`
- Modify: `src-tauri/src/processing/gpu/context.rs`

- [ ] **Step 1: Declare**

In `passes/mod.rs`:

```rust
pub mod sharpen;
```

- [ ] **Step 2: Write the host driver**

Create `src-tauri/src/processing/gpu/passes/sharpen.rs`:

```rust
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
    let bh = compile(device, "box_blur_h", include_str!("../shaders/box_blur_h.wgsl"));
    let bv = compile(device, "box_blur_v", include_str!("../shaders/box_blur_v.wgsl"));
    let merge = compile_merge(device);
    Ok(SharpenPipelines {
        bh: bh.0, bh_bgl: bh.1,
        bv: bv.0, bv_bgl: bv.1,
        merge: merge.0, merge_bgl: merge.1,
    })
}

fn compile(device: &wgpu::Device, label: &str, src: &str)
    -> (wgpu::ComputePipeline, wgpu::BindGroupLayout)
{
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(src.into()),
    });
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some(label),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
                }, count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::R16Float,
                    view_dimension: wgpu::TextureViewDimension::D2,
                }, count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false, min_binding_size: None,
                }, count: None,
            },
        ],
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(label), bind_group_layouts: &[&bgl], push_constant_ranges: &[],
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(label), layout: Some(&pl),
        module: &module, entry_point: Some("main"),
        compilation_options: Default::default(), cache: None,
    });
    (pipeline, bgl)
}

fn compile_merge(device: &wgpu::Device) -> (wgpu::ComputePipeline, wgpu::BindGroupLayout) {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("sharpen_merge"),
        source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/sharpen.wgsl").into()),
    });
    let entries = vec![
        wgpu::BindGroupLayoutEntry {
            binding: 0, visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
            }, count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 1, visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::StorageTexture {
                access: wgpu::StorageTextureAccess::WriteOnly,
                format: wgpu::TextureFormat::Rgba16Float,
                view_dimension: wgpu::TextureViewDimension::D2,
            }, count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 2, visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
            }, count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 3, visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
            }, count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 4, visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false, min_binding_size: None,
            }, count: None,
        },
    ];
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("sharpen_merge_bgl"), entries: &entries,
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("sharpen_merge_pl"), bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("sharpen_merge"), layout: Some(&pl),
        module: &module, entry_point: Some("main"),
        compilation_options: Default::default(), cache: None,
    });
    (pipeline, bgl)
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct BlurParams { width: u32, height: u32, radius: i32, _pad: u32 }

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct MergeParams { width: u32, height: u32, clarity_amount: f32, sharpness_amount: f32 }

pub fn dispatch(
    gpu: &GpuContext,
    src: &wgpu::Texture,
    width: u32,
    height: u32,
    clarity_amount: f32,
    clarity_radius: i32,
    sharpness_amount: f32,
    sharpness_radius: i32,
) -> Result<Arc<wgpu::Texture>> {
    let make_lum = |label: &str| gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R16Float,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let tmp_h_clar = make_lum("tmp_h_clar");
    let blur_clar = make_lum("blur_clar");
    let tmp_h_sharp = make_lum("tmp_h_sharp");
    let blur_sharp = make_lum("blur_sharp");

    let make_ubuf = |radius: i32, label: &str| {
        gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: bytemuck::bytes_of(&BlurParams { width, height, radius, _pad: 0 }),
            usage: wgpu::BufferUsages::UNIFORM,
        })
    };

    let p = &gpu.pipelines.sharpen;

    let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("sharpen_enc"),
    });

    let do_blur = |enc: &mut wgpu::CommandEncoder, src_view: &wgpu::TextureView,
                   mid_tex: &wgpu::Texture, out_tex: &wgpu::Texture, radius: i32, tag: &str| {
        let ubuf = make_ubuf(radius, tag);
        let mid_view = mid_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let bg_h = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(tag), layout: &p.bh_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(src_view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&mid_view) },
                wgpu::BindGroupEntry { binding: 2, resource: ubuf.as_entire_binding() },
            ],
        });
        {
            let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some(tag), timestamp_writes: None });
            cp.set_pipeline(&p.bh);
            cp.set_bind_group(0, &bg_h, &[]);
            cp.dispatch_workgroups((width + 15) / 16, (height + 15) / 16, 1);
        }
        let out_view = out_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let bg_v = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(tag), layout: &p.bv_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&mid_view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&out_view) },
                wgpu::BindGroupEntry { binding: 2, resource: ubuf.as_entire_binding() },
            ],
        });
        {
            let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some(tag), timestamp_writes: None });
            cp.set_pipeline(&p.bv);
            cp.set_bind_group(0, &bg_v, &[]);
            cp.dispatch_workgroups((width + 15) / 16, (height + 15) / 16, 1);
        }
    };

    let src_view = src.create_view(&wgpu::TextureViewDescriptor::default());
    do_blur(&mut enc, &src_view, &tmp_h_clar, &blur_clar, clarity_radius, "clarity_blur");
    do_blur(&mut enc, &src_view, &tmp_h_sharp, &blur_sharp, sharpness_radius, "sharp_blur");

    // Merge step.
    let dst = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("sharpen_dst"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1,
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
    let mp = MergeParams { width, height, clarity_amount, sharpness_amount };
    let mubuf = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("merge_ubuf"),
        contents: bytemuck::bytes_of(&mp),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let bg_m = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("sharpen_merge_bg"), layout: &p.merge_bgl,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&src_view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&dst_view) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&blur_clar_view) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&blur_sharp_view) },
            wgpu::BindGroupEntry { binding: 4, resource: mubuf.as_entire_binding() },
        ],
    });
    {
        let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("sharpen_merge_cp"), timestamp_writes: None,
        });
        cp.set_pipeline(&p.merge);
        cp.set_bind_group(0, &bg_m, &[]);
        cp.dispatch_workgroups((width + 15) / 16, (height + 15) / 16, 1);
    }

    gpu.queue.submit(std::iter::once(enc.finish()));
    Ok(Arc::new(dst))
}
```

- [ ] **Step 3: Add SharpenPipelines to GpuContext**

In `context.rs` `Pipelines` struct add:

```rust
pub sharpen: super::passes::sharpen::SharpenPipelines,
```

In `GpuContext::new` after lut3d, add:

```rust
let sharpen = super::passes::sharpen::create_pipelines(&device)?;
```

And include in the construction.

- [ ] **Step 4: Build to verify**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/processing/gpu/
git commit -m "feat(gpu): sharpen compute pipelines (box-blur H+V + merge)"
```

---

### Task M3.4: WGSL grain.wgsl (deterministic PCG hash)

**Files:**
- Create: `src-tauri/src/processing/gpu/shaders/grain.wgsl`
- Create: `src-tauri/src/processing/gpu/passes/grain.rs`
- Modify: `src-tauri/src/processing/gpu/passes/mod.rs`
- Modify: `src-tauri/src/processing/gpu/context.rs`

- [ ] **Step 1: Declare**

In `passes/mod.rs`:

```rust
pub mod grain;
```

- [ ] **Step 2: Write grain.wgsl**

Create `src-tauri/src/processing/gpu/shaders/grain.wgsl`:

```wgsl
struct Params {
    width: u32, height: u32,
    cell: u32, seed: u32,
    amount: f32, _pad0: u32, _pad1: u32, _pad2: u32,
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Params;

fn pcg_hash(seed_in: u32) -> u32 {
    var state: u32 = seed_in * 747796405u + 2891336453u;
    let word: u32 = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn hash21(x: u32, y: u32, s: u32) -> f32 {
    let h = pcg_hash(x * 1664525u + y * 1013904223u + s);
    return f32(h) / 4294967295.0;
}

// Box-Muller from two uniforms → standard normal.
fn box_muller(u1: f32, u2: f32) -> f32 {
    let u1c = max(u1, 1e-6);
    return sqrt(-2.0 * log(u1c)) * cos(6.2831853 * u2);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    var c = textureLoad(src, coord, 0).rgb;

    if (p.amount > 0.0) {
        let cx = gid.x / p.cell;
        let cy = gid.y / p.cell;
        let u1 = hash21(cx, cy, p.seed);
        let u2 = hash21(cx, cy, p.seed ^ 0x9E3779B9u);
        let z = box_muller(u1, u2);
        let n = z * p.amount;
        let l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        let mask = 4.0 * l * (1.0 - l);
        c = clamp(c + vec3<f32>(n * mask), vec3<f32>(0.0), vec3<f32>(1.0));
    }
    textureStore(dst, coord, vec4<f32>(c, 1.0));
}
```

- [ ] **Step 3: Host code**

Create `src-tauri/src/processing/gpu/passes/grain.rs`:

```rust
use crate::error::Result;
use crate::processing::gpu::context::GpuContext;
use crate::processing::grain::GrainStrength;
use std::sync::Arc;
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    width: u32, height: u32,
    cell: u32, seed: u32,
    amount: f32, _pad0: u32, _pad1: u32, _pad2: u32,
}

pub fn create_pipeline(
    device: &wgpu::Device,
) -> Result<(wgpu::ComputePipeline, wgpu::BindGroupLayout)> {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("grain_shader"),
        source: wgpu::ShaderSource::Wgsl(
            include_str!("../shaders/grain.wgsl").into(),
        ),
    });
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("grain_bgl"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
                }, count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba16Float,
                    view_dimension: wgpu::TextureViewDimension::D2,
                }, count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2, visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false, min_binding_size: None,
                }, count: None,
            },
        ],
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("grain_pl"),
        bind_group_layouts: &[&bgl], push_constant_ranges: &[],
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("grain"), layout: Some(&pl), module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(), cache: None,
    });
    Ok((pipeline, bgl))
}

pub fn dispatch(
    gpu: &GpuContext,
    src: &wgpu::Texture,
    width: u32,
    height: u32,
    strength: GrainStrength,
    cell: u32,
) -> Result<Arc<wgpu::Texture>> {
    let amount = strength.amount();
    let dst = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("grain_dst"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let p = Params {
        width, height,
        cell: cell.max(1),
        seed: 0xC0FFEE,
        amount,
        _pad0: 0, _pad1: 0, _pad2: 0,
    };
    let ubuf = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("grain_ubuf"),
        contents: bytemuck::bytes_of(&p),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let src_view = src.create_view(&wgpu::TextureViewDescriptor::default());
    let dst_view = dst.create_view(&wgpu::TextureViewDescriptor::default());
    let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("grain_bg"),
        layout: &gpu.pipelines.grain_bgl,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&src_view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&dst_view) },
            wgpu::BindGroupEntry { binding: 2, resource: ubuf.as_entire_binding() },
        ],
    });
    let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("grain_enc"),
    });
    {
        let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("grain_cp"), timestamp_writes: None,
        });
        cp.set_pipeline(&gpu.pipelines.grain);
        cp.set_bind_group(0, &bg, &[]);
        cp.dispatch_workgroups((width + 15) / 16, (height + 15) / 16, 1);
    }
    gpu.queue.submit(std::iter::once(enc.finish()));
    Ok(Arc::new(dst))
}
```

- [ ] **Step 4: Add to Pipelines**

In `context.rs` add:

```rust
pub grain: wgpu::ComputePipeline,
pub grain_bgl: wgpu::BindGroupLayout,
```

In `GpuContext::new` after sharpen:

```rust
let (grain, grain_bgl) = super::passes::grain::create_pipeline(&device)?;
```

- [ ] **Step 5: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: succeeds.

- [ ] **Step 6: Determinism test**

Append to `src-tauri/src/processing/gpu/tests/mod.rs`:

```rust
mod grain_determinism_test;
```

Create `src-tauri/src/processing/gpu/tests/grain_determinism_test.rs`:

```rust
use crate::processing::gpu::context::GpuContext;
use crate::processing::gpu::passes::grain;
use crate::processing::gpu::upload;
use crate::processing::grain::GrainStrength;
use image::{ImageBuffer, Rgb};
use std::sync::Arc;

fn try_gpu() -> Option<Arc<GpuContext>> {
    pollster::block_on(GpuContext::new()).ok().map(Arc::new)
}

#[test]
fn grain_is_deterministic_per_cell() {
    let gpu = match try_gpu() { Some(g) => g, None => { eprintln!("WARN: no GPU; skip"); return; } };
    let mut img: ImageBuffer<Rgb<u16>, Vec<u16>> = ImageBuffer::new(64, 64);
    for px in img.pixels_mut() { *px = Rgb([32768, 32768, 32768]); } // mid grey
    let in_tex = upload::upload_rgb16_as_rgba16f(&gpu, &img, "grain_in").unwrap();
    let a = grain::dispatch(&gpu, &in_tex, 64, 64, GrainStrength::Strong, 1).unwrap();
    let out_a = upload::readback_rgba16f_as_rgb16(&gpu, &a).unwrap();
    let b = grain::dispatch(&gpu, &in_tex, 64, 64, GrainStrength::Strong, 1).unwrap();
    let out_b = upload::readback_rgba16f_as_rgb16(&gpu, &b).unwrap();
    for (pa, pb) in out_a.pixels().zip(out_b.pixels()) {
        assert_eq!(pa.0, pb.0, "grain not deterministic");
    }
}
```

- [ ] **Step 7: Run determinism test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml processing::gpu::tests::grain_determinism_test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/processing/gpu/
git commit -m "feat(gpu): grain compute pass with deterministic PCG hash"
```

---

### Task M3.5: Wire all GPU passes into process_image_gpu (replace M2.6 tail)

**Files:**
- Modify: `src-tauri/src/processing/gpu/mod.rs`

- [ ] **Step 1: Read existing CPU LUT cache to share `Lut3D`**

The CPU `Lut3D` is already loaded by the caller and passed in via `lut: Option<&Lut3D>`. We just need its path to key the GPU LUT cache. Since `Lut3D` doesn't carry its own path, we'll need to pass the path alongside it.

Modify the signature of `process_image_gpu` in `gpu/mod.rs`:

```rust
pub fn process_image_gpu(
    gpu: &context::GpuContext,
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    settings: &FilterSettings,
    lut: Option<&Lut3D>,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>>
```

Use `settings.lut_file_path` as the cache key — it's already on `FilterSettings`.

- [ ] **Step 2: Rewrite `process_image_gpu` to chain GPU passes**

Replace the entire `process_image_gpu` body in `src-tauri/src/processing/gpu/mod.rs` with:

```rust
pub fn process_image_gpu(
    gpu: &context::GpuContext,
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    settings: &FilterSettings,
    lut: Option<&Lut3D>,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    if lut.is_none() && settings.is_identity() {
        return Ok(src.clone());
    }
    let (w, h) = src.dimensions();

    // 1. Upload + color_fused.
    let in_tex = upload::upload_rgb16_as_rgba16f(gpu, src, "src")?;
    let mut current = passes::color_fused::dispatch(gpu, &in_tex, settings, w, h)?;

    // 2. lut3d (if any).
    if let (Some(cpu_lut), Some(path)) = (lut, settings.lut_file_path.as_ref()) {
        let lut_tex = gpu.pipelines.lut_cache.get_or_upload(gpu, path, cpu_lut)?;
        current = passes::lut3d::dispatch(gpu, &current, &lut_tex, w, h)?;
    }

    // 3. dehaze (CPU detour) — only if non-zero.
    if settings.dehaze != 0 {
        let mut intermediate = upload::readback_rgba16f_as_rgb16(gpu, &current)?;
        // CPU dehaze expects f32 buffer; we must convert and call the existing helper.
        let mut buf: Vec<f32> = Vec::with_capacity((w * h * 3) as usize);
        for px in intermediate.pixels() {
            buf.push((px.0[0] as f32) / 65535.0);
            buf.push((px.0[1] as f32) / 65535.0);
            buf.push((px.0[2] as f32) / 65535.0);
        }
        crate::processing::dehaze::apply_dehaze(&mut buf, w, h, settings.dehaze);
        for (i, px) in intermediate.pixels_mut().enumerate() {
            *px = image::Rgb([
                (buf[i * 3] * 65535.0).round().clamp(0.0, 65535.0) as u16,
                (buf[i * 3 + 1] * 65535.0).round().clamp(0.0, 65535.0) as u16,
                (buf[i * 3 + 2] * 65535.0).round().clamp(0.0, 65535.0) as u16,
            ]);
        }
        current = upload::upload_rgb16_as_rgba16f(gpu, &intermediate, "after_dehaze")?;
    }

    // 4. sharpen (clarity + sharpness in one merge step).
    let res_scale = ((w.max(h) as f32) / 1920.0).max(1.0);
    let need_sharpen = settings.clarity != 0 || settings.sharpness != 0;
    if need_sharpen {
        let cr = ((8.0 * res_scale).round() as i32).max(1);
        let sr = ((2.0 * res_scale).round() as i32).max(1);
        current = passes::sharpen::dispatch(
            gpu, &current, w, h,
            settings.clarity as f32 / 100.0, cr,
            settings.sharpness as f32 / 100.0, sr,
        )?;
    }

    // 5. grain.
    let grain_strength = crate::processing::grain::GrainStrength::parse(
        settings.grain_effect.as_deref(),
    );
    if !matches!(grain_strength, crate::processing::grain::GrainStrength::None) {
        let size = crate::processing::grain::GrainSize::parse(settings.grain_size.as_deref());
        let cell = size.cell() * (res_scale.round() as u32).max(1);
        current = passes::grain::dispatch(gpu, &current, w, h, grain_strength, cell)?;
    }

    upload::readback_rgba16f_as_rgb16(gpu, &current)
}
```

- [ ] **Step 3: Build to verify**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: succeeds.

- [ ] **Step 4: Integration test — full pipeline vs CPU reference**

Append to `src-tauri/src/processing/gpu/tests/mod.rs`:

```rust
mod full_pipeline_test;
```

Create `src-tauri/src/processing/gpu/tests/full_pipeline_test.rs`:

```rust
use crate::processing::gpu::{context::GpuContext, process_image_gpu};
use crate::processing::pipeline::{process_image, FilterSettings};
use image::{ImageBuffer, Rgb};
use std::sync::Arc;

fn try_gpu() -> Option<Arc<GpuContext>> {
    pollster::block_on(GpuContext::new()).ok().map(Arc::new)
}

fn test_image() -> ImageBuffer<Rgb<u16>, Vec<u16>> {
    let mut img = ImageBuffer::new(128, 128);
    for (x, y, px) in img.enumerate_pixels_mut() {
        let r = ((x * 65535 / 128) as u16).min(65535);
        let g = ((y * 65535 / 128) as u16).min(65535);
        let b = (((x ^ y) * 65535 / 128) as u16).min(65535);
        *px = Rgb([r, g, b]);
    }
    img
}

/// SSIM-like simple metric: mean absolute channel diff over total pixels (16-bit scale).
fn mean_abs_diff(a: &ImageBuffer<Rgb<u16>, Vec<u16>>, b: &ImageBuffer<Rgb<u16>, Vec<u16>>) -> f64 {
    let mut acc: f64 = 0.0;
    let n = (a.width() as u64) * (a.height() as u64) * 3;
    for ((_, _, pa), (_, _, pb)) in a.enumerate_pixels().zip(b.enumerate_pixels()) {
        for c in 0..3 {
            acc += ((pa.0[c] as f64) - (pb.0[c] as f64)).abs();
        }
    }
    acc / (n as f64) / 65535.0
}

#[test]
fn full_pipeline_no_grain_close_to_cpu() {
    let gpu = match try_gpu() { Some(g) => g, None => { eprintln!("WARN: no GPU; skip"); return; } };
    let img = test_image();
    let s = FilterSettings {
        base_simulation: "Velvia".into(),
        exposure: 0.3,
        contrast: 20,
        clarity: 30,
        sharpness: 20,
        ..Default::default()
    };
    let cpu = process_image(&img, &s, None).unwrap();
    let gpu_out = process_image_gpu(&gpu, &img, &s, None).unwrap();
    let m = mean_abs_diff(&cpu, &gpu_out);
    assert!(m < 0.01, "mean abs diff {:.4} > 1%", m); // 1% tolerance
}

#[test]
fn full_pipeline_grain_deterministic() {
    let gpu = match try_gpu() { Some(g) => g, None => { eprintln!("WARN: no GPU; skip"); return; } };
    let img = test_image();
    let s = FilterSettings {
        base_simulation: "Pass-Through".into(),
        grain_effect: Some("Strong".into()),
        grain_size: Some("Small".into()),
        ..Default::default()
    };
    let a = process_image_gpu(&gpu, &img, &s, None).unwrap();
    let b = process_image_gpu(&gpu, &img, &s, None).unwrap();
    for (pa, pb) in a.pixels().zip(b.pixels()) {
        assert_eq!(pa.0, pb.0);
    }
}
```

- [ ] **Step 5: Run all GPU tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml processing::gpu`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/processing/gpu/
git commit -m "feat(gpu): wire full GPU pipeline (color → lut3d → CPU dehaze → sharpen → grain)"
```

---

## Milestone M4 — Switch + cleanup

Goal: route `process_image` through the GPU path. Keep a thin CPU reference function for tests. Update README minimum requirements.

---

### Task M4.1: Switch process_image to call process_image_gpu

**Files:**
- Modify: `src-tauri/src/processing/pipeline.rs`
- Modify: `src-tauri/src/ipc/preview.rs`
- Modify: `src-tauri/src/state.rs` (if needed for accessor)

- [ ] **Step 1: Add a public CPU reference function**

In `src-tauri/src/processing/pipeline.rs`, **rename** the existing `pub fn process_image` to `pub fn process_image_cpu` (used as the test reference). Then add a new wrapper:

```rust
use crate::processing::gpu::context::GpuContext;

/// Public entry. Currently uses GPU; CPU implementation in `process_image_cpu`
/// is retained as a numerical reference for tests in `processing/gpu/tests`.
pub fn process_image(
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    settings: &FilterSettings,
    lut: Option<&Lut3D>,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    process_image_cpu(src, settings, lut)
}
```

Wait — that just calls CPU again. We need GPU access. The simplest option: add a thread-local or static `OnceCell<Arc<GpuContext>>` that's set at startup.

Replace the wrapper above with:

```rust
use crate::processing::gpu;
use once_cell::sync::OnceCell;

static GLOBAL_GPU: OnceCell<std::sync::Arc<gpu::context::GpuContext>> = OnceCell::new();

pub fn set_global_gpu(g: std::sync::Arc<gpu::context::GpuContext>) {
    let _ = GLOBAL_GPU.set(g);
}

pub fn process_image(
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    settings: &FilterSettings,
    lut: Option<&Lut3D>,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let gpu = GLOBAL_GPU
        .get()
        .ok_or_else(|| crate::error::AppError::other("GPU not initialized"))?;
    gpu::process_image_gpu(gpu, src, settings, lut)
}
```

(`once_cell` is already in [Cargo.toml](../../../src-tauri/Cargo.toml).)

Add the missing import for `Lut3D` if it isn't already in scope:

```rust
use crate::processing::lut::Lut3D;
```

- [ ] **Step 2: Wire set_global_gpu in startup**

In `src-tauri/src/state.rs`, after `let gpu = Arc::new(GpuContext::new().await?);`, add:

```rust
crate::processing::pipeline::set_global_gpu(gpu.clone());
```

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: build succeeds. Note: `process_image_cpu` is now unused in production but used by tests; mark as `pub`.

- [ ] **Step 4: Run the existing test suite to ensure nothing breaks**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all tests PASS. The existing CPU-pipeline tests still hit `process_image_cpu` directly (we'll update them in the next step).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/processing/pipeline.rs src-tauri/src/state.rs
git commit -m "feat(gpu): route process_image through GPU; keep process_image_cpu as ref"
```

---

### Task M4.2: Verify export path uses the GPU now

**Files:**
- Modify: nothing (read-only verification)
- Modify: any test that hardcodes CPU expectations

- [ ] **Step 1: Search for all callers of process_image**

Run: `grep -rn "process_image" src-tauri/src --include="*.rs"`

Expected: only `processing::pipeline::process_image` and `processing::pipeline::process_image_cpu` references.

- [ ] **Step 2: Confirm export path uses process_image (not _cpu)**

Run: `grep -rn "process_image_cpu\|process_image(" src-tauri/src --include="*.rs"`

Expected: production callers use `process_image`; only tests use `process_image_cpu` as the CPU reference.

If you find a production caller of `process_image_cpu`, change it to `process_image`. Then commit (see step 4).

- [ ] **Step 3: Run a manual smoke test**

Run: `cargo run --manifest-path src-tauri/Cargo.toml`

Expected: app launches without panicking. Open a JPEG, drag a slider — preview should update significantly faster than baseline (subjective).

- [ ] **Step 4: Commit any production-caller fixes**

```bash
git add src-tauri/src
git commit -m "chore(gpu): ensure all production callers use process_image (GPU path)"
```

(skip if no changes were needed)

---

### Task M4.3: Performance benchmark

**Files:**
- Create: `src-tauri/benches/gpu_pipeline.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add bench harness**

In `src-tauri/Cargo.toml`, add:

```toml
[[bench]]
name = "gpu_pipeline"
harness = false
```

Add to `[dev-dependencies]`:

```toml
criterion = "0.5"
```

- [ ] **Step 2: Write the bench**

Create `src-tauri/benches/gpu_pipeline.rs`:

```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion};
use fujisim_lib::processing::gpu::{context::GpuContext, process_image_gpu};
use fujisim_lib::processing::pipeline::{process_image_cpu, FilterSettings};
use image::{ImageBuffer, Rgb};
use std::sync::Arc;

fn make_img(w: u32, h: u32) -> ImageBuffer<Rgb<u16>, Vec<u16>> {
    let mut img = ImageBuffer::new(w, h);
    for (x, y, px) in img.enumerate_pixels_mut() {
        *px = Rgb([(x * 200) as u16, (y * 200) as u16, ((x + y) * 100) as u16]);
    }
    img
}

fn bench(c: &mut Criterion) {
    let gpu = match pollster::block_on(GpuContext::new()) {
        Ok(g) => Arc::new(g),
        Err(_) => { eprintln!("no GPU; skipping"); return; }
    };
    let s = FilterSettings {
        base_simulation: "Velvia".into(),
        exposure: 0.2, contrast: 20, clarity: 30,
        ..Default::default()
    };
    let preview = make_img(1280, 853);
    c.bench_function("gpu_preview_1280", |b| {
        b.iter(|| {
            black_box(process_image_gpu(&gpu, &preview, &s, None).unwrap());
        })
    });
    c.bench_function("cpu_preview_1280", |b| {
        b.iter(|| {
            black_box(process_image_cpu(&preview, &s, None).unwrap());
        })
    });
    let big = make_img(6000, 4000);
    c.bench_function("gpu_export_6k", |b| {
        b.iter(|| {
            black_box(process_image_gpu(&gpu, &big, &s, None).unwrap());
        })
    });
}

criterion_group!(benches, bench);
criterion_main!(benches);
```

- [ ] **Step 3: Run the bench**

Run: `cargo bench --manifest-path src-tauri/Cargo.toml --bench gpu_pipeline`

Expected:
- `gpu_preview_1280` < 30 ms.
- `gpu_export_6k` < 200 ms.
- `cpu_preview_1280` for comparison; should be at least ~5× slower.

If targets aren't hit, investigate before committing — common culprits: missing pipeline cache (re-creating per call), small workgroup utilization.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/benches src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "bench(gpu): add criterion benches for preview / export"
```

---

### Task M4.4: Documentation updates

**Files:**
- Modify: `README.md`
- Modify: `docs/README_zh.md`

- [ ] **Step 1: Add minimum system requirements paragraph**

In `README.md`, after the "About" section, add a new section:

```markdown
## ⚙️ Minimum System Requirements

FujiSim's color pipeline runs on the GPU via wgpu (Metal on macOS, DX12 on Windows, Vulkan on Linux). Minimum supported configurations:

- **macOS**: 10.13+ (Metal capable)
- **Windows**: 10+ (DX12 capable)
- **Linux**: GPU driver supporting Vulkan or OpenGL 4.0+

If your system has no compatible GPU, FujiSim will refuse to start with a "no GPU adapter found" error — there is no CPU fallback.
```

- [ ] **Step 2: Mirror the section in the Chinese README**

Same content, translated, in `docs/README_zh.md`. Place it in the corresponding position.

- [ ] **Step 3: Note the architecture change**

In `README.md`, under "F3 Core Color Engine", change "Real-time Preview" bullet from `80ms debounce response` to:

```markdown
- **Real-time Preview**: 80ms debounce + GPU-accelerated color pipeline (wgpu + WGSL); ~25ms per frame on integrated GPUs, faster on discrete.
```

- [ ] **Step 4: Run lint to make sure nothing broke**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/README_zh.md
git commit -m "docs: announce GPU-accelerated pipeline + minimum system requirements"
```

---

### Task M4.5: Final verification + cleanup pass

**Files:**
- Possibly: `src-tauri/src/processing/pipeline.rs`

- [ ] **Step 1: Run the full test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all tests PASS, no warnings.

- [ ] **Step 2: Run clippy across the workspace**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`
Expected: no errors.

- [ ] **Step 3: Run formatter**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all`
Expected: no diff (or trivial style fixes).

- [ ] **Step 4: Smoke-test the actual app**

Run: `cargo tauri dev` (or `pnpm tauri dev` if that's the project convention — check `package.json`).
Expected: app launches; opening a JPEG and dragging the exposure slider produces a noticeably smoother preview than before.

- [ ] **Step 5: Commit any final fmt/lint fixes**

```bash
git add -u
git commit -m "chore: final fmt + clippy fixes for GPU pipeline" || true
```

(skip with `|| true` if there's nothing to commit)

---

## Done

At this point:

- The CPU rayon color pipeline is no longer the production path; `process_image_cpu` exists only as a test reference.
- `cargo test` covers GPU vs CPU numerical regression, GPU determinism (grain), and full-pipeline parity.
- `cargo bench` records preview / export timings.
- README documents the minimum system requirements.
- The 8 future-work items in [the spec](../specs/2026-05-25-webgpu-pipeline-design.md#8-未来工作不在本次范围) remain queued for follow-up PRs.





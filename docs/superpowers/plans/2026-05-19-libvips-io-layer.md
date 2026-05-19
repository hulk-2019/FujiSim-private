# libvips I/O Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `image` crate's codec layer with libvips for all decode/resize/encode operations, keeping the Rust film-simulation pipeline intact, and bump preview_base resolution to 1600px with Lanczos3 filtering.

**Architecture:** A new `vips_io` module wraps all libvips calls behind a stable Rust API. The existing `ImageBuffer<Rgb<u16>>` type remains the pipeline's internal currency; `vips_io` bridges in/out via raw pixel memory. `VipsImage` is never stored or sent across threads — it is created, used, and dropped within a single function call.

**Tech Stack:** `libvips = "2.0.0"` (olxgroup-oss bindings), `image = "0.25" default-features=false features=["bmp"]` (BMP export only + ImageBuffer type), `once_cell` (VipsApp singleton). macOS: `brew install vips` + Homebrew dylib path in `build.rs`. Windows: vendor DLLs from libvips/build-win64-mxe v8.18.2.

---

### Task 1: Dependencies + build.rs

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/build.rs`

- [ ] **Step 1: Update Cargo.toml**

In `src-tauri/Cargo.toml`, replace the `image` and `imageproc` lines and add `libvips`:

```toml
libvips = "2.0.0"
image = { version = "0.25", default-features = false, features = ["bmp"] }
# remove: imageproc = "0.25"
```

- [ ] **Step 2: Update build.rs to add libvips link search paths**

Replace the contents of `src-tauri/build.rs`:

```rust
fn main() {
    // macOS: add Homebrew lib path so the linker finds libvips and glib
    #[cfg(target_os = "macos")]
    {
        let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
        let brew_lib = if arch == "aarch64" {
            "/opt/homebrew/lib"
        } else {
            "/usr/local/lib"
        };
        println!("cargo:rustc-link-search=native={brew_lib}");
    }
    // Windows: vendor DLLs placed in src-tauri/vendor/vips/lib/
    #[cfg(target_os = "windows")]
    {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        println!("cargo:rustc-link-search=native={manifest}/vendor/vips/lib");
    }
    tauri_build::build()
}
```

- [ ] **Step 3: macOS — install libvips via Homebrew**

```bash
brew install vips
```

- [ ] **Step 4: Verify linking**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

Expected: no `ld: library not found for -lvips` errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/build.rs
git commit -m "build: add libvips dependency, configure platform link paths"
```

---

### Task 2: Create `src-tauri/src/vips_io.rs` — VipsApp init + pixel bridge

**Files:**
- Create: `src-tauri/src/vips_io.rs`

- [ ] **Step 1: Write the module skeleton with VipsApp singleton and pixel bridge helpers**

Create `src-tauri/src/vips_io.rs`:

```rust
use crate::error::{AppError, Result};
use crate::export::ExportFormat;
use image::{ImageBuffer, Rgb, RgbaImage};
use libvips::{ops, VipsApp, VipsImage};
use libvips::ops::{BandFormat, Direction, Angle, JpegsaveOptions, PngsaveOptions,
                   WebpsaveOptions, TiffsaveOptions, ResizeOptions, Kernel, Size,
                   ThumbnailOptions};
use once_cell::sync::Lazy;
use std::path::Path;

static VIPS: Lazy<VipsApp> = Lazy::new(|| {
    VipsApp::new("FujiSim", false).expect("libvips init failed")
});

pub fn ensure_init() {
    Lazy::force(&VIPS);
}

// ── pixel bridge ─────────────────────────────────────────────────────────────

fn rgb16_to_vips(img: &ImageBuffer<Rgb<u16>, Vec<u16>>) -> Result<VipsImage> {
    let (w, h) = img.dimensions();
    let pixels: &[u16] = img.as_raw();
    // reinterpret &[u16] as &[u8] (native endian, same as libvips expects)
    let bytes = unsafe {
        std::slice::from_raw_parts(pixels.as_ptr() as *const u8, pixels.len() * 2)
    };
    VipsImage::new_from_memory(bytes, w as i32, h as i32, 3, BandFormat::Ushort)
        .map_err(|e| AppError::Vips(e.to_string()))
}

fn vips_to_rgb16(vimg: &VipsImage) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let w = vimg.get_width() as u32;
    let h = vimg.get_height() as u32;
    let raw = vimg.image_write_to_memory(); // Vec<u8>, native-endian u16 pairs
    let pixels: Vec<u16> = raw
        .chunks_exact(2)
        .map(|b| u16::from_ne_bytes([b[0], b[1]]))
        .collect();
    ImageBuffer::from_raw(w, h, pixels)
        .ok_or_else(|| AppError::Vips("vips→rgb16 buffer size mismatch".into()))
}
```

- [ ] **Step 2: cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -10
```

Expected: no errors (module not yet registered, so just syntax check via direct path).

- [ ] **Step 3: Register module in lib.rs**

In `src-tauri/src/lib.rs`, add after `pub mod state;`:

```rust
pub mod vips_io;
```

- [ ] **Step 4: cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -10
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/vips_io.rs src-tauri/src/lib.rs
git commit -m "feat: add vips_io module skeleton with VipsApp init and pixel bridge"
```

---

### Task 3: `vips_io` — decode, resize, image_dimensions

**Files:**
- Modify: `src-tauri/src/vips_io.rs`

- [ ] **Step 1: Add `decode_to_rgb16`, `decode_bytes_to_rgb16`, `resize_rgb16`, `image_dimensions` to vips_io.rs**

Append to `src-tauri/src/vips_io.rs`:

```rust
pub fn decode_to_rgb16(path: &Path) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    ensure_init();
    let path_str = path.to_str()
        .ok_or_else(|| AppError::Vips("non-UTF8 path".into()))?;
    let vimg = VipsImage::new_from_file(path_str)
        .map_err(|e| AppError::Vips(format!("decode {path_str}: {e}")))?;
    let vimg = ops::cast(&vimg, BandFormat::Ushort)
        .map_err(|e| AppError::Vips(format!("cast ushort: {e}")))?;
    // strip alpha if present (RGBA → RGB)
    let vimg = if vimg.get_bands() == 4 {
        ops::extract_band(&vimg, 0)
            .and_then(|r| ops::bandjoin(&[&r,
                &ops::extract_band(&vimg, 1)?,
                &ops::extract_band(&vimg, 2)?]))
            .map_err(|e| AppError::Vips(format!("strip alpha: {e}")))?
    } else {
        vimg
    };
    vips_to_rgb16(&vimg)
}

pub fn decode_bytes_to_rgb16(data: &[u8]) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    ensure_init();
    let vimg = VipsImage::new_from_buffer(data, "")
        .map_err(|e| AppError::Vips(format!("decode bytes: {e}")))?;
    let vimg = ops::cast(&vimg, BandFormat::Ushort)
        .map_err(|e| AppError::Vips(format!("cast ushort: {e}")))?;
    vips_to_rgb16(&vimg)
}

pub fn resize_rgb16(
    img: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    nw: u32,
    nh: u32,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    ensure_init();
    let (w, h) = img.dimensions();
    let vimg = rgb16_to_vips(img)?;
    let hscale = nw as f64 / w as f64;
    let vscale = nh as f64 / h as f64;
    let resized = ops::resize_with_opts(&vimg, hscale, &ResizeOptions {
        kernel: Kernel::Lanczos3,
        vscale,
        ..ResizeOptions::default()
    }).map_err(|e| AppError::Vips(format!("resize: {e}")))?;
    vips_to_rgb16(&resized)
}

pub fn image_dimensions(path: &Path) -> Result<(u32, u32)> {
    ensure_init();
    let path_str = path.to_str()
        .ok_or_else(|| AppError::Vips("non-UTF8 path".into()))?;
    let vimg = VipsImage::new_from_file(path_str)
        .map_err(|e| AppError::Vips(format!("dimensions {path_str}: {e}")))?;
    Ok((vimg.get_width() as u32, vimg.get_height() as u32))
}
```

- [ ] **Step 2: cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -10
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/vips_io.rs
git commit -m "feat: vips_io decode_to_rgb16, decode_bytes_to_rgb16, resize_rgb16, image_dimensions"
```

---

### Task 4: `vips_io` — encode functions + JPEG orientation helper

**Files:**
- Modify: `src-tauri/src/vips_io.rs`

- [ ] **Step 1: Add encode functions and apply_jpeg_orientation to vips_io.rs**

Append to `src-tauri/src/vips_io.rs`:

```rust
/// Encode Rgb<u16> buffer to bytes. JPEG/WebP/TIFF/GIF downconvert to 8-bit internally.
/// PNG preserves 16-bit when format is Png.
pub fn encode_rgb16(
    img: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    format: ExportFormat,
    quality: u8,
) -> Result<Vec<u8>> {
    ensure_init();
    let vimg = rgb16_to_vips(img)?;
    match format {
        ExportFormat::Jpeg => {
            let vimg8 = ops::cast(&vimg, BandFormat::Uchar)
                .map_err(|e| AppError::Vips(e.to_string()))?;
            ops::jpegsave_buffer_with_opts(&vimg8, &JpegsaveOptions {
                q: quality as i32,
                optimize_coding: true,
                ..JpegsaveOptions::default()
            }).map_err(|e| AppError::Vips(e.to_string()))
        }
        ExportFormat::Png => {
            ops::pngsave_buffer_with_opts(&vimg, &PngsaveOptions {
                bitdepth: 16,
                compression: 6,
                ..PngsaveOptions::default()
            }).map_err(|e| AppError::Vips(e.to_string()))
        }
        ExportFormat::Webp => {
            let vimg8 = ops::cast(&vimg, BandFormat::Uchar)
                .map_err(|e| AppError::Vips(e.to_string()))?;
            ops::webpsave_buffer_with_opts(&vimg8, &WebpsaveOptions {
                q: quality as i32,
                ..WebpsaveOptions::default()
            }).map_err(|e| AppError::Vips(e.to_string()))
        }
        ExportFormat::Tiff => {
            let vimg8 = ops::cast(&vimg, BandFormat::Uchar)
                .map_err(|e| AppError::Vips(e.to_string()))?;
            ops::tiffsave_buffer(&vimg8)
                .map_err(|e| AppError::Vips(e.to_string()))
        }
        ExportFormat::Gif => {
            let vimg8 = ops::cast(&vimg, BandFormat::Uchar)
                .map_err(|e| AppError::Vips(e.to_string()))?;
            ops::gifsave_buffer(&vimg8)
                .map_err(|e| AppError::Vips(e.to_string()))
        }
        ExportFormat::Bmp => {
            // libvips has no bmpsave — fall back to image crate
            let (w, h) = img.dimensions();
            let mut rgb8 = image::RgbImage::new(w, h);
            for (x, y, px) in img.enumerate_pixels() {
                rgb8.put_pixel(x, y, image::Rgb([
                    (px.0[0] >> 8) as u8,
                    (px.0[1] >> 8) as u8,
                    (px.0[2] >> 8) as u8,
                ]));
            }
            let mut buf = std::io::Cursor::new(Vec::new());
            rgb8.write_to(&mut buf, image::ImageFormat::Bmp)
                .map_err(|e| AppError::Vips(e.to_string()))?;
            Ok(buf.into_inner())
        }
    }
}

pub fn encode_rgb16_to_file(
    img: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    path: &Path,
    format: ExportFormat,
    quality: u8,
) -> Result<()> {
    let bytes = encode_rgb16(img, format, quality)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

/// Decode JPEG bytes, apply EXIF orientation (rotate/flip), re-encode to JPEG.
/// orientation values follow EXIF spec (1=normal, 2-8=various transforms).
pub fn apply_jpeg_orientation(jpeg: Vec<u8>, orientation: u32) -> Result<Vec<u8>> {
    if orientation == 1 {
        return Ok(jpeg);
    }
    ensure_init();
    let vimg = VipsImage::new_from_buffer(&jpeg, ".jpg")
        .map_err(|e| AppError::Vips(format!("orient decode: {e}")))?;
    let rotated = match orientation {
        2 => ops::flip(&vimg, Direction::Horizontal),
        3 => ops::rot(&vimg, Angle::D180),
        4 => ops::flip(&vimg, Direction::Vertical),
        5 => ops::rot(&vimg, Angle::D90)
                .and_then(|r| ops::flip(&r, Direction::Horizontal)),
        6 => ops::rot(&vimg, Angle::D90),
        7 => ops::rot(&vimg, Angle::D270)
                .and_then(|r| ops::flip(&r, Direction::Horizontal)),
        8 => ops::rot(&vimg, Angle::D270),
        _ => return Ok(jpeg),
    }.map_err(|e| AppError::Vips(format!("orient transform: {e}")))?;
    ops::jpegsave_buffer_with_opts(&rotated, &JpegsaveOptions {
        q: 90,
        ..JpegsaveOptions::default()
    }).map_err(|e| AppError::Vips(e.to_string()))
}

/// Load watermark PNG, resize to (out_w, out_h), return as RgbaImage.
pub fn load_watermark(path: &Path, out_w: u32, out_h: u32) -> Result<RgbaImage> {
    ensure_init();
    let path_str = path.to_str()
        .ok_or_else(|| AppError::Vips("non-UTF8 path".into()))?;
    let vimg = VipsImage::new_from_file(path_str)
        .map_err(|e| AppError::Vips(format!("watermark open: {e}")))?;
    let (wm_w, wm_h) = (vimg.get_width() as u32, vimg.get_height() as u32);
    let vimg = if (wm_w, wm_h) != (out_w, out_h) {
        let hscale = out_w as f64 / wm_w as f64;
        let vscale = out_h as f64 / wm_h as f64;
        ops::resize_with_opts(&vimg, hscale, &ResizeOptions {
            kernel: Kernel::Lanczos3,
            vscale,
            ..ResizeOptions::default()
        }).map_err(|e| AppError::Vips(format!("watermark resize: {e}")))?
    } else {
        vimg
    };
    // ensure RGBA
    let vimg = if vimg.get_bands() == 3 {
        ops::bandjoin_const(&vimg, &[255.0])
            .map_err(|e| AppError::Vips(e.to_string()))?
    } else {
        vimg
    };
    let raw = vimg.image_write_to_memory();
    RgbaImage::from_raw(out_w, out_h, raw)
        .ok_or_else(|| AppError::Vips("watermark buffer mismatch".into()))
}
```

- [ ] **Step 2: cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -10
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/vips_io.rs
git commit -m "feat: vips_io encode_rgb16, apply_jpeg_orientation, load_watermark"
```

---

### Task 5: Update `error.rs` — replace Image variant with Vips

**Files:**
- Modify: `src-tauri/src/error.rs`

- [ ] **Step 1: Replace the Image variant**

In `src-tauri/src/error.rs`, replace:

```rust
    /// `image` crate 解码/编码失败
    #[error("image: {0}")]
    Image(#[from] image::ImageError),
```

with:

```rust
    /// libvips 操作失败
    #[error("vips: {0}")]
    Vips(String),
```

- [ ] **Step 2: cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

Expected: errors pointing to call sites that used `Image(...)` — these will be fixed in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/error.rs
git commit -m "feat: replace AppError::Image with AppError::Vips(String)"
```

---

### Task 6: Update `processing/mod.rs` and `asset/scanner.rs`

**Files:**
- Modify: `src-tauri/src/processing/mod.rs`
- Modify: `src-tauri/src/asset/scanner.rs`

- [ ] **Step 1: Update processing/mod.rs**

In `src-tauri/src/processing/mod.rs`, replace the `load_image_rgb16` function body:

```rust
pub fn load_image_rgb16(path: &Path) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    use crate::asset::format::{classify, FileKind};
    match classify(path) {
        FileKind::Image => crate::vips_io::decode_to_rgb16(path),
        FileKind::Raw => raw::decode_raw_rgb16(path),
        FileKind::Unsupported => Err(crate::error::AppError::Unsupported(
            path.display().to_string(),
        )),
    }
}
```

Also remove the `use image::{ImageBuffer, Rgb};` import if it's no longer needed (keep it if `ImageBuffer` is still referenced in the file).

- [ ] **Step 2: Update asset/scanner.rs**

In `src-tauri/src/asset/scanner.rs` at line 114, replace:

```rust
                if let Ok(dim) = image::image_dimensions(path) {
                    width = Some(dim.0 as i64);
                    height = Some(dim.1 as i64);
                }
```

with:

```rust
                if let Ok(dim) = crate::vips_io::image_dimensions(path) {
                    width = Some(dim.0 as i64);
                    height = Some(dim.1 as i64);
                }
```

- [ ] **Step 3: cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/processing/mod.rs src-tauri/src/asset/scanner.rs
git commit -m "feat: migrate processing/mod.rs and scanner.rs to vips_io"
```

---

### Task 7: Update `processing/raw.rs` — orientation + cover/preview_base (800→1600px)

**Files:**
- Modify: `src-tauri/src/processing/raw.rs`

- [ ] **Step 1: Replace `apply_jpeg_orientation` function**

In `src-tauri/src/processing/raw.rs`, replace the entire `apply_jpeg_orientation` function (lines 37-67):

```rust
fn apply_jpeg_orientation(jpeg: Vec<u8>, orientation: u32) -> Result<Vec<u8>> {
    crate::vips_io::apply_jpeg_orientation(jpeg, orientation)
}
```

- [ ] **Step 2: Replace `decode_lossy_dng` tile decode call**

In `decode_lossy_dng`, replace:

```rust
        let tile_img =
            image::load_from_memory_with_format(tile_bytes, image::ImageFormat::Jpeg)
                .map_err(|e| AppError::other(format!("DNG tile {i} decode failed: {e}")))?;
        let tile_rgb = tile_img.to_rgb16();
```

with:

```rust
        let tile_rgb = crate::vips_io::decode_bytes_to_rgb16(tile_bytes)
            .map_err(|e| AppError::other(format!("DNG tile {i} decode failed: {e}")))?;
```

- [ ] **Step 3: Replace `decode_linear_dng` body**

Replace:

```rust
fn decode_linear_dng(data: &[u8]) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let img = image::load_from_memory_with_format(data, image::ImageFormat::Tiff)
        .map_err(|e| AppError::other(format!("linear DNG decode failed: {e}")))?;
    let linear = img.to_rgb16();
```

with:

```rust
fn decode_linear_dng(data: &[u8]) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let linear = crate::vips_io::decode_bytes_to_rgb16(data)
        .map_err(|e| AppError::other(format!("linear DNG decode failed: {e}")))?;
```

- [ ] **Step 4: Replace `extract_cover_fast` resize+encode**

In `extract_cover_fast`, replace the `image::load_from_memory_with_format` + resize + encode block with:

```rust
    let vimg = libvips::VipsImage::new_from_buffer(&jpeg, ".jpg")
        .map_err(|e| AppError::other(format!("cover decode: {e}")))?;
    let (w, h) = (vimg.get_width() as u32, vimg.get_height() as u32);
    let out = if w.max(h) > max_edge {
        let scale = max_edge as f64 / w.max(h) as f64;
        libvips::ops::resize_with_opts(&vimg, scale, &libvips::ops::ResizeOptions {
            kernel: libvips::ops::Kernel::Lanczos3,
            ..libvips::ops::ResizeOptions::default()
        }).map_err(|e| AppError::other(format!("cover resize: {e}")))?
    } else {
        vimg
    };
    libvips::ops::jpegsave_buffer_with_opts(&out, &libvips::ops::JpegsaveOptions {
        q: 88,
        ..libvips::ops::JpegsaveOptions::default()
    }).map_err(|e| AppError::other(format!("cover encode: {e}")))
```

- [ ] **Step 5: Update `generate_cover_and_preview_base` — bump to 1600px + Lanczos3**

In `generate_cover_and_preview_base`, replace the cover and preview_base sections:

```rust
    let (w, h) = rgb16.dimensions();

    // ── cover 400px JPEG ─────────────────────────────────────────────────────
    let cover_jpeg = {
        let cover_w = ((w as f32 * (400f32 / w.max(h) as f32).min(1.0)).round() as u32).max(1);
        let cover_h = ((h as f32 * (400f32 / w.max(h) as f32).min(1.0)).round() as u32).max(1);
        let cover_16 = crate::vips_io::resize_rgb16(&rgb16, cover_w, cover_h)?;
        crate::vips_io::encode_rgb16(&cover_16, crate::export::ExportFormat::Jpeg, 88)?
    };

    // ── preview_base 1600px 16-bit PNG ───────────────────────────────────────
    let preview_png = {
        let scale = (1600f32 / w.max(h) as f32).min(1.0);
        let prev_w = ((w as f32 * scale).round() as u32).max(1);
        let prev_h = ((h as f32 * scale).round() as u32).max(1);
        let preview_16 = if scale < 1.0 {
            crate::vips_io::resize_rgb16(&rgb16, prev_w, prev_h)?
        } else {
            rgb16
        };
        crate::vips_io::encode_rgb16(&preview_16, crate::export::ExportFormat::Png, 0)?
    };

    Ok((cover_jpeg, preview_png))
```

- [ ] **Step 6: cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/processing/raw.rs
git commit -m "feat: migrate raw.rs to vips_io, bump preview_base to 1600px Lanczos3"
```

---

### Task 8: Update `ipc.rs` — preview load + resize + encode

**Files:**
- Modify: `src-tauri/src/ipc.rs`

- [ ] **Step 1: Replace `load_and_downsample`**

In `src-tauri/src/ipc.rs`, replace the entire `load_and_downsample` function:

```rust
fn load_and_downsample(path: &Path, max_edge: u32) -> Result<image::ImageBuffer<image::Rgb<u16>, Vec<u16>>> {
    use crate::asset::format::{classify, FileKind};
    let src = match classify(path) {
        FileKind::Raw => processing::raw::decode_raw_rgb16_for_preview(path, max_edge)?,
        _ => processing::load_image_rgb16(path)?,
    };
    let (w, h) = src.dimensions();
    let scale = (max_edge as f32 / w.max(h) as f32).min(1.0);
    if scale < 1.0 {
        let nw = (w as f32 * scale).round().max(1.0) as u32;
        let nh = (h as f32 * scale).round().max(1.0) as u32;
        crate::vips_io::resize_rgb16(&src, nw, nh)
    } else {
        Ok(src)
    }
}
```

- [ ] **Step 2: Replace preview_base PNG load in `get_preview`**

In `get_preview`, replace the `image::open(&pp_path)` block (around line 374):

```rust
                    let img = crate::vips_io::decode_to_rgb16(&pp_path)
                        .map_err(|e| AppError::other(format!("preview_base read: {e}")))?;
```

Remove the `.to_rgb16()` call that followed it.

- [ ] **Step 3: Replace JPEG encode in `render_preview_from_cache`**

In `render_preview_from_cache`, replace the `rgb8` construction + `JpegEncoder` block with:

```rust
        let jpeg = crate::vips_io::encode_rgb16(
            &processed,
            crate::export::ExportFormat::Jpeg,
            88,
        )?;
        std::fs::write(&out_path, &jpeg)
            .map_err(|e| crate::error::AppError::other(format!("preview write: {e}")))?;
```

Remove the `image::RgbImage`, `put_pixel` loop, `Cursor`, and `JpegEncoder` lines.

- [ ] **Step 4: cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ipc.rs
git commit -m "feat: migrate ipc.rs preview path to vips_io"
```

---

### Task 9: Update `export/mod.rs` — resize + encode + watermark

**Files:**
- Modify: `src-tauri/src/export/mod.rs`

- [ ] **Step 1: Replace resize in `export_one`**

In `export_one`, replace both `image::imageops::resize` calls with `crate::vips_io::resize_rgb16`:

```rust
        Some(ResizeSpec::LongEdge(le)) => {
            let (w, h) = processed.dimensions();
            let scale = (*le as f32) / (w.max(h) as f32);
            if scale >= 1.0 {
                processed
            } else {
                let nw = (w as f32 * scale).round() as u32;
                let nh = (h as f32 * scale).round() as u32;
                let resized = crate::vips_io::resize_rgb16(&processed, nw, nh)?;
                drop(processed);
                resized
            }
        }
        Some(ResizeSpec::Percent(p)) => {
            let (w, h) = processed.dimensions();
            let s = (*p as f32) / 100.0;
            let nw = (w as f32 * s).round().max(1.0) as u32;
            let nh = (h as f32 * s).round().max(1.0) as u32;
            let resized = crate::vips_io::resize_rgb16(&processed, nw, nh)?;
            drop(processed);
            resized
        }
```

- [ ] **Step 2: Replace encode block in `export_one`**

Replace the `rgb8` construction + `match export.format` encode block with:

```rust
    // watermark composite (still uses image crate RgbaImage for pixel math)
    let final_image = if let Some(wm_path) = watermark_path {
        match crate::vips_io::load_watermark(wm_path, out_w, out_h) {
            Ok(overlay) => {
                let mut rgb8 = to_rgb8(&final_image);
                composite_watermark(&mut rgb8, &overlay);
                // convert back to rgb16 for unified encode path
                let pixels: Vec<u16> = rgb8.pixels()
                    .flat_map(|p| [p.0[0] as u16 * 257, p.0[1] as u16 * 257, p.0[2] as u16 * 257])
                    .collect();
                image::ImageBuffer::from_raw(out_w, out_h, pixels).unwrap_or(final_image)
            }
            Err(e) => { tracing::warn!("watermark skipped: {e}"); final_image }
        }
    } else {
        final_image
    };

    crate::vips_io::encode_rgb16_to_file(&final_image, &out, export.format, export.quality)?;
```

Add a helper at the bottom of the file:

```rust
fn to_rgb8(img: &ImageBuffer<Rgb<u16>, Vec<u16>>) -> RgbImage {
    let (w, h) = img.dimensions();
    let mut out = RgbImage::new(w, h);
    for (x, y, px) in img.enumerate_pixels() {
        out.put_pixel(x, y, Rgb([(px.0[0] >> 8) as u8, (px.0[1] >> 8) as u8, (px.0[2] >> 8) as u8]));
    }
    out
}
```

Remove `load_watermark_from_file` function and the old encode `match` block.

- [ ] **Step 3: cargo check**

```bash
cd src-tauri && cargo check 2>&1 | grep "^error" | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/export/mod.rs
git commit -m "feat: migrate export/mod.rs resize and encode to vips_io"
```

---

### Task 10: Full build verification + macOS dylib bundling

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Full cargo build**

```bash
cd src-tauri && cargo build 2>&1 | grep "^error" | head -20
```

Expected: clean build.

- [ ] **Step 2: Remove unused image imports**

Search for remaining `use image::` imports that reference removed codec types:

```bash
grep -rn "image::codecs\|image::imageops\|image::DynamicImage\|image::ImageFormat\|image::open\|image::load_from_memory" src-tauri/src/
```

Remove any that remain (they should all be gone after Tasks 6-9).

- [ ] **Step 3: cargo build again to confirm clean**

```bash
cd src-tauri && cargo build 2>&1 | grep -E "^error|^warning.*unused import" | head -20
```

- [ ] **Step 4: Add libvips dylibs to Tauri bundle resources (macOS)**

In `src-tauri/tauri.conf.json`, add a `resources` key inside `bundle`:

```json
"bundle": {
  "active": true,
  "targets": "all",
  "resources": {
    "/opt/homebrew/lib/libvips.42.dylib": "libs/libvips.42.dylib",
    "/opt/homebrew/lib/libglib-2.0.0.dylib": "libs/libglib-2.0.0.dylib",
    "/opt/homebrew/lib/libgobject-2.0.0.dylib": "libs/libgobject-2.0.0.dylib"
  },
  "icon": [...]
}
```

Note: exact dylib filenames may differ — run `brew list vips | grep dylib` to confirm.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/src/
git commit -m "feat: complete libvips migration, add macOS dylib bundle resources"
```

- [ ] **Step 6: Manual smoke test**

1. `pnpm tauri dev`
2. Import a RAW file — verify preview loads at 1600px
3. Adjust a filter — verify preview re-renders
4. Export as JPEG, PNG, WebP, TIFF, BMP — verify all formats produce valid files
5. Check RAW thumbnail orientation is correct for a rotated shot

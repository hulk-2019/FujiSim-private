# libvips I/O 层替换设计

**日期：** 2026-05-19
**状态：** 已确认，待实现

## 背景与目标

当前 `image` crate（纯 Rust）在以下方面性能不足：
- JPEG decode/encode 比 libjpeg-turbo 慢 3-5x
- `imageops::resize` 使用 Triangle 滤波，预览图质量差
- Lanczos3 resize 在纯 Rust 实现下 CPU 占用高

目标：用 libvips 替换所有 I/O 和 resize 操作，核心管线（胶片模拟 / 颗粒 / 3D LUT / 曲线）保持不动。

## 方案：libvips I/O 层 + Rust 管线桥接

### 整体架构

```
磁盘文件
    │
    ▼
┌──────────────────────────────────┐
│  vips_io  (NEW)                  │
│  - decode → ImageBuffer<Rgb<u16>>│  ← VipsImage + new_from_memory 桥接
│  - resize  → ImageBuffer<Rgb<u16>>│  ← Lanczos3
│  - encode_jpeg / png / webp / …  │
└──────────────────────────────────┘
         ↕  内存拷贝桥接（一次）
┌──────────────────────────────────┐
│  现有 Rust 管线（不动）           │
│  fuji / grain / lut / curves     │
│  pipeline::process_image         │
└──────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────┐
│  vips_io encode                  │
│  → 落盘 JPEG / PNG / WebP / …   │
└──────────────────────────────────┘
```

**关键原则：**
- libvips 负责所有 codec（decode/resize/encode）
- `ImageBuffer<Rgb<u16>>` 只作为管线内部数据结构
- 中间通过 `new_from_memory` / `image_write_to_memory` 做一次内存桥接
- 3D LUT 三线性插值和胶片颗粒合成继续留在 Rust（libvips 不原生支持）

## 新增模块：`src-tauri/src/vips_io.rs`

### 公开接口

```rust
// decode 任意格式文件 → Rgb<u16> 管线数据
pub fn decode_to_rgb16(path: &Path) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>>

// decode 内存中的 JPEG/PNG 字节 → Rgb<u16>（RAW thumbnail 路径用）
pub fn decode_bytes_to_rgb16(data: &[u8]) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>>

// Rgb<u16> → 编码字节（预览 + 导出用）
pub fn encode_rgb16(img: &ImageBuffer<Rgb<u16>, Vec<u16>>, format: ExportFormat, quality: u8) -> Result<Vec<u8>>
pub fn encode_rgb16_to_file(img: &ImageBuffer<Rgb<u16>, Vec<u16>>, path: &Path, format: ExportFormat, quality: u8) -> Result<()>

// 高质量缩放（Lanczos3），替代 image::imageops::resize
pub fn resize_rgb16(img: &ImageBuffer<Rgb<u16>, Vec<u16>>, nw: u32, nh: u32) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>>

// 读取图片宽高（替代 image::image_dimensions，用于 scanner.rs）
pub fn image_dimensions(path: &Path) -> Result<(u32, u32)>

// 水印加载 + resize（替代 export/mod.rs 里的 load_watermark_from_file）
pub fn load_watermark(path: &Path, out_w: u32, out_h: u32) -> Result<image::RgbaImage>
```

### VipsApp 生命周期

`once_cell::sync::Lazy<VipsApp>` 在 `vips_io.rs` 内部持有，应用启动时自动 init，全局唯一。

## 预览分辨率调整

| 项目 | 旧值 | 新值 |
|------|------|------|
| preview_base 长边 | 800px | **1600px** |
| 编码格式 | 16-bit PNG | 16-bit PNG（不变） |
| resize 滤波 | Triangle | **Lanczos3** |

**理由：** Mac Retina（2x）下 1600px = 800px 物理像素，视觉密度与旧版相同但更清晰；覆盖 Windows 4K 屏；PNG 压缩后约 4-6MB/张，LRU 20 张上限下缓存目录约 80-120MB，可接受。

## 静态打包策略（macOS + Windows）

**方案 B：预编译静态二进制**

使用 `sharp` 项目维护的预编译 libvips 静态包（`@img/sharp-libvips-darwin-*`），包含 libjpeg-turbo / libpng / libwebp 等所有依赖合并为单个 `.a`。

`build.rs` 负责：
1. 根据 `CARGO_CFG_TARGET_OS` + `CARGO_CFG_TARGET_ARCH` 选择对应预编译包
2. 解压 `.a` 到 `$OUT_DIR`
3. `println!("cargo:rustc-link-search=...")` + `println!("cargo:rustc-link-lib=static=vips-cpp")` 等

用户零依赖，CI 可离线构建。`.a` 文件提交进 repo（约 30MB，置于 `vendor/libvips/`）。

## 错误处理变更

- `AppError` 新增 `Vips(String)` variant
- 移除 `Image(#[from] image::ImageError)`
- `vips_io.rs` 内部统一转换，call site 不感知底层错误类型

## Cargo.toml 变更

```toml
# 添加
libvips = "2"

# 修改：去掉 codec features，只保留数据结构
image = { version = "0.25", default-features = false }

# 移除
# imageproc = "0.25"
```

## 改动范围（call site）

| 文件 | 改动内容 |
|------|---------|
| `src/vips_io.rs` | 新增，所有 libvips 调用封装在此 |
| `src/processing/mod.rs` | `image::open` → `vips_io::decode_to_rgb16` |
| `src/processing/raw.rs` | `image::load_from_memory_with_format` + `imageops::rotate*` + `write_to` → `vips_io::*`；resize + encode → `vips_io::resize_rgb16` + `vips_io::encode_rgb16`；preview_base 长边常量 800 → 1600 |
| `src/ipc.rs` | `load_and_downsample` 中 `imageops::resize` → `vips_io::resize_rgb16`；`JpegEncoder` → `vips_io::encode_rgb16` |
| `src/export/mod.rs` | `imageops::resize` Lanczos3 → `vips_io::resize_rgb16`；所有编码 → `vips_io::encode_rgb16_to_file`；`load_watermark_from_file` → `vips_io::load_watermark` |
| `src/asset/scanner.rs` | `image::image_dimensions` → `vips_io::image_dimensions` |
| `src/error.rs` | 移除 `Image(#[from] image::ImageError)`，添加 `Vips(String)` |
| `src-tauri/Cargo.toml` | 依赖变更如上 |
| `src-tauri/build.rs` | 新增静态链接逻辑 |

## 验证标准

- `cargo test` 全部通过
- 预览图 1600px 长边，Lanczos3 质量可见提升
- 导出 JPEG / PNG / WebP / TIFF / BMP 各格式正常落盘
- RAW thumbnail orientation 校正不退化
- 应用冷启动 VipsApp init 无 panic

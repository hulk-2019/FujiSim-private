use crate::error::{AppError, Result};
use crate::processing::color;
use image::{ImageBuffer, Rgb};
use rsraw::BIT_DEPTH_16;
use std::path::Path;

/// 提取 RAW/DNG 文件中嵌入的最大 JPEG 预览，返回原始 JPEG 字节。
///
/// 主路径：rsraw `extract_thumbs`（相机直出 RAW/DNG）。
/// 降级路径：TIFF 解析器扫描所有 IFD，找最大 JPEG 压缩图像（DNG 嵌入预览）。
///
/// 返回的 JPEG 已将像素数据旋转到正向，EXIF orientation 重置为 1，
/// 避免浏览器 <img> 标签再次应用 orientation 导致二次旋转。
///
/// 注意：部分相机（如 Canon CR2）嵌入的 JPEG 缩略图本身不含 EXIF orientation，
/// 旋转信息只存在于外层 RAW/TIFF 文件的 IFD0，因此需要双重回退读取。
pub fn extract_raw_thumbnail(path: &Path) -> Result<Vec<u8>> {
    let data = std::fs::read(path)?;

    let jpeg = if let Ok(j) = extract_thumb_rsraw(&data) {
        j
    } else {
        extract_thumb_tiff(&data)?
    };

    // 先从 JPEG 自身 EXIF 读取 orientation；
    // 若 JPEG 无 EXIF（如 Canon CR2 嵌入缩略图），回退到外层 RAW/TIFF 文件的 IFD0。
    let orientation = read_jpeg_orientation(&jpeg)
        .or_else(|| read_tiff_file_orientation(&data))
        .unwrap_or(1);

    apply_jpeg_orientation(jpeg, orientation)
}

/// 读取 JPEG 的 EXIF orientation，把像素旋转到正向后重新编码，orientation 标签置 1。
/// 若 orientation 已经是 1 或无法解析，原样返回。
fn apply_jpeg_orientation(jpeg: Vec<u8>, orientation: u32) -> Result<Vec<u8>> {
    if orientation == 1 {
        return Ok(jpeg);
    }

    let img = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
        .map_err(|e| AppError::other(format!("thumbnail decode: {e}")))?;

    let rotated = match orientation {
        2 => image::DynamicImage::ImageRgb8(image::imageops::flip_horizontal(&img.to_rgb8())),
        3 => image::DynamicImage::ImageRgb8(image::imageops::rotate180(&img.to_rgb8())),
        4 => image::DynamicImage::ImageRgb8(image::imageops::flip_vertical(&img.to_rgb8())),
        5 => {
            let r = image::imageops::rotate90(&img.to_rgb8());
            image::DynamicImage::ImageRgb8(image::imageops::flip_horizontal(&r))
        }
        6 => image::DynamicImage::ImageRgb8(image::imageops::rotate90(&img.to_rgb8())),
        7 => {
            let r = image::imageops::rotate270(&img.to_rgb8());
            image::DynamicImage::ImageRgb8(image::imageops::flip_horizontal(&r))
        }
        8 => image::DynamicImage::ImageRgb8(image::imageops::rotate270(&img.to_rgb8())),
        _ => img,
    };

    let mut buf = std::io::Cursor::new(Vec::new());
    rotated
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .map_err(|e| AppError::other(format!("thumbnail re-encode: {e}")))?;
    Ok(buf.into_inner())
}

/// 从外层 RAW/TIFF 文件的 IFD0 读取 orientation 标签（tag 0x0112）。
/// 用于嵌入 JPEG 缩略图本身不含 EXIF orientation 的情况（如 Canon CR2）。
pub(crate) fn read_tiff_file_orientation(data: &[u8]) -> Option<u32> {
    let t = Tiff::new(data).ok()?;
    let ifd0 = t.u32(4) as usize;
    t.tag(ifd0, 0x0112).map(|(_, _, v)| v & 0xFFFF)
}

/// 从 JPEG APP1/EXIF 段中读取 orientation 标签（tag 0x0112）。
fn read_jpeg_orientation(data: &[u8]) -> Option<u32> {
    if data.get(0..2) != Some(&[0xFF, 0xD8]) {
        return None;
    }
    let mut i = 2usize;
    while i + 3 < data.len() {
        if data[i] != 0xFF {
            break;
        }
        let marker = data[i + 1];
        let seg_len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        // APP1 = 0xE1，包含 EXIF
        if marker == 0xE1 && i + 2 + seg_len <= data.len() {
            let seg = &data[i + 4..i + 2 + seg_len];
            if seg.starts_with(b"Exif\0\0") {
                return parse_tiff_orientation(&seg[6..]);
            }
        }
        i += 2 + seg_len;
    }
    None
}

fn parse_tiff_orientation(tiff: &[u8]) -> Option<u32> {
    if tiff.len() < 8 {
        return None;
    }
    let le = match &tiff[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |off: usize| -> Option<u16> {
        let b = tiff.get(off..off + 2)?;
        Some(if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    };
    let u32_at = |off: usize| -> Option<u32> {
        let b = tiff.get(off..off + 4)?;
        Some(if le {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    let ifd0 = u32_at(4)? as usize;
    let n = u16_at(ifd0)? as usize;
    for i in 0..n {
        let e = ifd0 + 2 + i * 12;
        if u16_at(e)? == 0x0112 {
            return Some(u32_at(e + 8)? & 0xFFFF);
        }
    }
    None
}

fn extract_thumb_rsraw(data: &[u8]) -> Result<Vec<u8>> {
    let mut raw = rsraw::RawImage::open(data)
        .map_err(|e| AppError::other(format!("rsraw open: {e}")))?;
    let thumbs = raw
        .extract_thumbs()
        .map_err(|e| AppError::other(format!("extract thumbs: {e}")))?;
    thumbs
        .into_iter()
        .filter(|t| t.format == rsraw::ThumbFormat::Jpeg)
        .max_by_key(|t| t.width * t.height)
        .map(|t| t.data)
        .ok_or_else(|| AppError::other("no JPEG thumbnail via rsraw"))
}

fn extract_thumb_tiff(data: &[u8]) -> Result<Vec<u8>> {
    let t = Tiff::new(data)?;
    let ifd0 = t.u32(4) as usize;

    // 收集 IFD0 + 所有 SubIFD
    let mut ifds = vec![ifd0];
    if let Some((_, cnt, val)) = t.tag(ifd0, 330) {
        for off in t.u32_array(val, cnt) {
            ifds.push(off as usize);
        }
    }

    // 找最大的 JPEG 图像（compression 6 = old JPEG, 7 = JPEG）
    let best = ifds
        .iter()
        .filter_map(|&ifd| {
            let comp = t.tag(ifd, 259)?.2;
            if comp != 6 && comp != 7 {
                return None;
            }
            let w = t.tag(ifd, 256)?.2;
            let h = t.tag(ifd, 257)?.2;
            // Strip-based（嵌入预览通常是单 strip 完整 JPEG）
            if let Some((_, cnt, val)) = t.tag(ifd, 273) {
                let offsets = t.u32_array(val, cnt);
                let sizes = t.tag(ifd, 279).map(|(_, c, v)| t.u32_array(v, c))?;
                let total: u32 = sizes.iter().sum();
                return Some((w * h, offsets[0], total));
            }
            None
        })
        .max_by_key(|&(area, _, _)| area);

    if let Some((_, off, size)) = best {
        return Ok(data[off as usize..(off + size) as usize].to_vec());
    }

    Err(AppError::other("no embedded JPEG preview found in DNG/TIFF"))
}

/// 解码 RAW 文件，输出 16-bit sRGB 图像（已按 EXIF orientation 旋转到正向）。
///
/// 按顺序尝试三条路径：
///   1. rsraw（LibRaw）：相机直出 RAW/DNG，process() 内部已应用 S.flip，输出已是正向
///   2. Lossy JPEG DNG：压缩格式 34892 分块拼合，需手动应用 orientation
///   3. 线性 DNG：本质是 TIFF，需手动应用 orientation
pub fn decode_raw_rgb16(path: &Path) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let data = std::fs::read(path)?;
    decode_raw_rgb16_from_bytes(&data, None)
}

/// 预览专用解码：根据目标长边 `max_edge` 动态决定是否启用 LibRaw half_size 模式。
/// 当原始尺寸 / 2 仍大于 `max_edge` 时启用，约快 4x；否则全分辨率解码避免降质。
pub fn decode_raw_rgb16_for_preview(path: &Path, max_edge: u32) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let data = std::fs::read(path)?;
    decode_raw_rgb16_from_bytes(&data, Some(max_edge))
}

fn decode_raw_rgb16_from_bytes(data: &[u8], max_edge: Option<u32>) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    if let Ok(img) = decode_with_libraw(data, max_edge) {
        return Ok(img);
    }

    let orientation = read_tiff_file_orientation(data).unwrap_or(1);

    let img = if let Ok(img) = decode_lossy_dng(data) {
        img
    } else {
        decode_linear_dng(data)?
    };

    Ok(apply_orientation_rgb16(img, orientation))
}

fn apply_orientation_rgb16(
    img: ImageBuffer<Rgb<u16>, Vec<u16>>,
    orientation: u32,
) -> ImageBuffer<Rgb<u16>, Vec<u16>> {
    match orientation {
        2 => image::imageops::flip_horizontal(&img),
        3 => image::imageops::rotate180(&img),
        4 => image::imageops::flip_vertical(&img),
        5 => image::imageops::flip_horizontal(&image::imageops::rotate90(&img)),
        6 => image::imageops::rotate90(&img),
        7 => image::imageops::flip_horizontal(&image::imageops::rotate270(&img)),
        8 => image::imageops::rotate270(&img),
        _ => img,
    }
}

fn decode_with_libraw(data: &[u8], max_edge: Option<u32>) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let mut raw = rsraw::RawImage::open(data)
        .map_err(|e| AppError::other(format!("LibRaw open: {e}")))?;

    // 使用相机白平衡和色彩矩阵，保留原始色彩意图
    raw.set_use_camera_wb(true);
    raw.set_use_camera_matrix(true);
    // 预览模式：原始长边 / 2 仍大于目标时启用 half_size，约快 4x；否则全分辨率避免降质
    if let Some(target) = max_edge {
        let native_max = raw.width().max(raw.height());
        if native_max / 2 > target {
            raw.set_half_size(true);
        }
    }

    raw.unpack()
        .map_err(|e| AppError::other(format!("LibRaw unpack: {e}")))?;

    let processed = raw
        .process::<BIT_DEPTH_16>()
        .map_err(|e| AppError::other(format!("LibRaw process: {e}")))?;

    let width = processed.width();
    let height = processed.height();

    if processed.colors() != 3 {
        return Err(AppError::other(format!(
            "LibRaw: expected 3 color channels, got {}",
            processed.colors()
        )));
    }

    // ProcessedImage<BIT_DEPTH_16> derefs to [u16] directly
    let pixels: Vec<u16> = processed.to_vec();

    ImageBuffer::<Rgb<u16>, Vec<u16>>::from_raw(width, height, pixels)
        .ok_or_else(|| AppError::other("LibRaw: pixel buffer size mismatch"))
}

// ── DNG Lossy JPEG 降级路径 ───────────────────────────────────────────────────

fn decode_lossy_dng(data: &[u8]) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let t = Tiff::new(data)?;
    let ifd0 = t.u32(4) as usize;

    let (_, sub_cnt, sub_val) = t
        .tag(ifd0, 330)
        .ok_or_else(|| AppError::other("DNG: SubIFD tag (330) not found"))?;

    let sub_ifds = t.u32_array(sub_val, sub_cnt);

    let best = sub_ifds
        .iter()
        .filter_map(|&off| {
            let off = off as usize;
            let w = t.tag(off, 256)?.2;
            let h = t.tag(off, 257)?.2;
            let comp = t.tag(off, 259)?.2;
            if comp == 34892 { Some((w, h, off)) } else { None }
        })
        .max_by_key(|&(w, h, _)| w * h)
        .ok_or_else(|| AppError::other("DNG: no Lossy JPEG SubIFD found"))?;

    let (img_w, img_h, full_ifd) = best;

    let tile_w = t
        .tag(full_ifd, 322)
        .map(|(_, _, v)| v)
        .ok_or_else(|| AppError::other("DNG: TileWidth (322) not found"))?;
    let tile_h = t
        .tag(full_ifd, 323)
        .map(|(_, _, v)| v)
        .ok_or_else(|| AppError::other("DNG: TileLength (323) not found"))?;

    let (_, tile_cnt, off_val) = t
        .tag(full_ifd, 324)
        .ok_or_else(|| AppError::other("DNG: TileOffsets (324) not found"))?;
    let (_, _, bc_val) = t
        .tag(full_ifd, 325)
        .ok_or_else(|| AppError::other("DNG: TileByteCounts (325) not found"))?;

    let offsets = t.u32_array(off_val, tile_cnt);
    let counts = t.u32_array(bc_val, tile_cnt);

    let tiles_x = (img_w + tile_w - 1) / tile_w;
    let mut out: ImageBuffer<Rgb<u16>, Vec<u16>> = ImageBuffer::new(img_w, img_h);

    for (i, (&off, &cnt)) in offsets.iter().zip(counts.iter()).enumerate() {
        let tile_bytes = &data[off as usize..(off + cnt) as usize];
        let tile_img =
            image::load_from_memory_with_format(tile_bytes, image::ImageFormat::Jpeg)
                .map_err(|e| AppError::other(format!("DNG tile {i} decode failed: {e}")))?;
        let tile_rgb = tile_img.to_rgb16();

        let tx = (i as u32 % tiles_x) * tile_w;
        let ty = (i as u32 / tiles_x) * tile_h;

        for (x, y, px) in tile_rgb.enumerate_pixels() {
            let ox = tx + x;
            let oy = ty + y;
            if ox < img_w && oy < img_h {
                out.put_pixel(ox, oy, *px);
            }
        }
    }

    Ok(out)
}

// ── 线性 DNG 路径（Lightroom 导出等，本质是 TIFF）────────────────────────────

fn decode_linear_dng(data: &[u8]) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let img = image::load_from_memory_with_format(data, image::ImageFormat::Tiff)
        .map_err(|e| AppError::other(format!("linear DNG decode failed: {e}")))?;
    let linear = img.to_rgb16();
    // 线性光 → sRGB gamma，使流水线的色调曲线和 >> 8 输出在正确色彩空间工作
    let (w, h) = linear.dimensions();
    let mut out = ImageBuffer::new(w, h);
    for (x, y, px) in linear.enumerate_pixels() {
        let enc = |v: u16| -> u16 {
            let g = color::linear_to_srgb(v as f32 / 65535.0);
            (g.clamp(0.0, 1.0) * 65535.0).round() as u16
        };
        out.put_pixel(x, y, Rgb([enc(px.0[0]), enc(px.0[1]), enc(px.0[2])]));
    }
    Ok(out)
}

// ── 最小化 TIFF 解析器 ────────────────────────────────────────────────────────

struct Tiff<'a> {
    data: &'a [u8],
    le: bool,
}

impl<'a> Tiff<'a> {
    fn new(data: &'a [u8]) -> Result<Self> {
        if data.len() < 8 {
            return Err(AppError::other("DNG: file too small"));
        }
        let le = match &data[0..2] {
            b"II" => true,
            b"MM" => false,
            _ => return Err(AppError::other("DNG: not a TIFF file")),
        };
        Ok(Self { data, le })
    }

    fn u16(&self, off: usize) -> u16 {
        let b = &self.data[off..off + 2];
        if self.le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) }
    }

    fn u32(&self, off: usize) -> u32 {
        let b = &self.data[off..off + 4];
        if self.le {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        }
    }

    fn tag(&self, ifd: usize, target: u16) -> Option<(u16, u32, u32)> {
        let n = self.u16(ifd) as usize;
        for i in 0..n {
            let e = ifd + 2 + i * 12;
            if self.u16(e) == target {
                return Some((self.u16(e + 2), self.u32(e + 4), self.u32(e + 8)));
            }
        }
        None
    }

    fn u32_array(&self, val: u32, count: u32) -> Vec<u32> {
        if count == 1 {
            vec![val]
        } else {
            (0..count as usize)
                .map(|i| self.u32(val as usize + i * 4))
                .collect()
        }
    }
}

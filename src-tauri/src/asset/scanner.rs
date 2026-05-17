use crate::asset::{exif::ExifData, format::{self, FileKind}};
use crate::db::assets::NewAsset;
use crate::error::Result;
use crate::processing::raw::read_tiff_file_orientation;
use std::path::Path;
use walkdir::WalkDir;

/// 一次目录扫描的结果。
pub struct ScanResult {
    /// 准备插入到 SQLite 的资产记录
    pub items: Vec<NewAsset>,
    /// 被跳过的文件数（扩展名不在白名单内的）
    pub skipped: usize,
}

/// 递归扫描目录，把所有支持的图片归集为 `NewAsset` 列表。
pub fn scan_dir(root: &Path) -> Result<ScanResult> {
    let mut items = Vec::new();
    let mut skipped = 0usize;
    for entry in WalkDir::new(root).follow_links(false).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let kind = format::classify(path);
        if kind == FileKind::Unsupported {
            skipped += 1;
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let file_type = format::ext_upper(path);
        let metadata = entry.metadata().ok();
        let file_size = metadata.as_ref().map(|m| m.len() as i64);

        let (exif, width, height) = extract_meta(path, kind);
        items.push(build_asset(path, file_name, file_type, file_size, exif, width, height, kind));
    }
    Ok(ScanResult { items, skipped })
}

/// 处理用户手动选择的文件列表（不递归），跳过不支持的格式。
pub fn scan_files(paths: &[std::path::PathBuf]) -> Result<ScanResult> {
    let mut items = Vec::new();
    let mut skipped = 0usize;
    for path in paths {
        if !path.is_file() {
            skipped += 1;
            continue;
        }
        let kind = format::classify(path);
        if kind == FileKind::Unsupported {
            skipped += 1;
            continue;
        }
        let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let file_type = format::ext_upper(path);
        let file_size = path.metadata().ok().map(|m| m.len() as i64);

        let (exif, width, height) = extract_meta(path, kind);
        items.push(build_asset(path, file_name, file_type, file_size, exif, width, height, kind));
    }
    Ok(ScanResult { items, skipped })
}

/// 根据文件类型提取元数据和尺寸（已应用 orientation，直接是显示尺寸）。
fn extract_meta(path: &Path, kind: FileKind) -> (ExifData, Option<i64>, Option<i64>) {
    match kind {
        FileKind::Image => {
            let exif = crate::asset::exif::read(path).unwrap_or_default();
            let mut width = exif.width;
            let mut height = exif.height;
            if width.is_none() || height.is_none() {
                if let Ok(dim) = image::image_dimensions(path) {
                    width = Some(dim.0 as i64);
                    height = Some(dim.1 as i64);
                }
            }
            let orientation = exif.orientation.unwrap_or(1);
            let (dw, dh) = display_dims(width, height, orientation);
            (exif, dw, dh)
        }
        FileKind::Raw => {
            let is_dng = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("dng"))
                .unwrap_or(false);

            // 读一次文件，供后续所有操作复用，避免重复 IO
            let file_data = std::fs::read(path).ok();

            if is_dng {
                let exif = crate::asset::exif::read(path).unwrap_or_default();
                let (raw_w, raw_h) = if exif.width.is_some() && exif.height.is_some() {
                    (exif.width, exif.height)
                } else {
                    file_data.as_deref().map(read_dng_dimensions_from_bytes).unwrap_or((None, None))
                };
                let orientation = exif.orientation
                    .or_else(|| file_data.as_deref().and_then(read_tiff_file_orientation))
                    .unwrap_or(1);
                let (dw, dh) = display_dims(raw_w, raw_h, orientation);
                (exif, dw, dh)
            } else {
                let exif = file_data.as_deref().map(read_raw_meta_from_bytes).unwrap_or_default();
                let raw_w = exif.width;
                let raw_h = exif.height;
                let orientation = file_data.as_deref()
                    .and_then(read_tiff_file_orientation)
                    .unwrap_or(1);
                let (dw, dh) = display_dims(raw_w, raw_h, orientation);
                (exif, dw, dh)
            }
        }
        FileKind::Unsupported => (ExifData::default(), None, None),
    }
}

/// 从 DNG/TIFF 文件的 IFD 中读取最大图层的像素尺寸（tag 256=ImageWidth, 257=ImageLength）。
/// 遍历 IFD0 + 所有 SubIFD，取面积最大的那个。
fn read_dng_dimensions_from_bytes(data: &[u8]) -> (Option<i64>, Option<i64>) {
    if data.len() < 8 {
        return (None, None);
    }
    let le = match &data[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return (None, None),
    };
    let u16_at = |off: usize| -> Option<u16> {
        let b = data.get(off..off + 2)?;
        Some(if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    };
    let u32_at = |off: usize| -> Option<u32> {
        let b = data.get(off..off + 4)?;
        Some(if le {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    let tag_val = |ifd: usize, target: u16| -> Option<u32> {
        let n = u16_at(ifd)? as usize;
        for i in 0..n {
            let e = ifd + 2 + i * 12;
            if u16_at(e)? == target {
                return u32_at(e + 8);
            }
        }
        None
    };

    let ifd0 = match u32_at(4) {
        Some(v) => v as usize,
        None => return (None, None),
    };
    let mut ifds = vec![ifd0];
    // SubIFD (tag 330)
    if let Some(n) = tag_val(ifd0, 330) {
        let cnt = {
            let n_entries = u16_at(ifd0).unwrap_or(0) as usize;
            let mut c = 0u32;
            for i in 0..n_entries {
                let e = ifd0 + 2 + i * 12;
                if u16_at(e) == Some(330) {
                    c = u32_at(e + 4).unwrap_or(1);
                    break;
                }
            }
            c
        };
        if cnt == 1 {
            ifds.push(n as usize);
        } else {
            for i in 0..cnt as usize {
                if let Some(off) = u32_at(n as usize + i * 4) {
                    ifds.push(off as usize);
                }
            }
        }
    }

    let best = ifds.iter().filter_map(|&ifd| {
        let w = tag_val(ifd, 256)?;
        let h = tag_val(ifd, 257)?;
        Some((w, h))
    }).max_by_key(|&(w, h)| w * h);

    match best {
        Some((w, h)) => (Some(w as i64), Some(h as i64)),
        None => (None, None),
    }
}

/// 用 rsraw（LibRaw）读取 RAW 文件的相机元数据和真实尺寸。
fn read_raw_meta_from_bytes(data: &[u8]) -> ExifData {
    let raw = match rsraw::RawImage::open(data) {
        Ok(r) => r,
        Err(_) => return ExifData::default(),
    };

    let clean = |s: std::borrow::Cow<'_, str>| -> Option<String> {
        let s = s.trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    };

    let date_taken = raw.datetime().map(|dt| {
        dt.format("%Y-%m-%d %H:%M:%S").to_string()
    });

    let shutter = raw.shutter();
    let shutter_speed = if shutter > 0.0 {
        Some(if shutter < 1.0 {
            format!("1/{}", (1.0 / shutter).round() as u32)
        } else {
            format!("{}", shutter)
        })
    } else {
        None
    };

    let aperture = raw.aperture();
    let f_number = if aperture > 0.0 { Some(aperture as f64) } else { None };

    let focal = raw.focal_len();
    let focal_length = if focal > 0.0 { Some(focal as f64) } else { None };

    let iso = raw.iso_speed();
    let iso = if iso > 0 { Some(iso as i64) } else { None };

    let lens_info = raw.lens_info();
    let lens_model = {
        let name = lens_info.lens_name.trim().to_string();
        if name.is_empty() { None } else { Some(name) }
    };

    // rsraw width/height 是解码后的实际像素尺寸
    let width = Some(raw.width() as i64);
    let height = Some(raw.height() as i64);

    ExifData {
        date_taken,
        camera_make: clean(raw.make()),
        camera_model: clean(raw.model()),
        lens_model,
        iso,
        f_number,
        shutter_speed,
        focal_length,
        width,
        height,
        orientation: None,
    }
}

/// 根据 EXIF orientation 把传感器尺寸换算为显示尺寸（orientation 5/6/7/8 需交换宽高）。
fn display_dims(w: Option<i64>, h: Option<i64>, orientation: u32) -> (Option<i64>, Option<i64>) {
    match orientation {
        5 | 6 | 7 | 8 => (h, w),
        _ => (w, h),
    }
}

fn build_asset(
    path: &Path,
    file_name: String,
    file_type: Option<String>,
    file_size: Option<i64>,
    exif: ExifData,
    width: Option<i64>,
    height: Option<i64>,
    kind: FileKind,
) -> NewAsset {
    NewAsset {
        file_path: path.to_string_lossy().to_string(),
        file_name,
        file_type,
        file_size,
        date_taken: exif.date_taken,
        camera_make: exif.camera_make,
        camera_model: exif.camera_model,
        lens_model: exif.lens_model,
        iso: exif.iso,
        f_number: exif.f_number,
        shutter_speed: exif.shutter_speed,
        focal_length: exif.focal_length,
        width,
        height,
        is_raw: matches!(kind, FileKind::Raw),
    }
}


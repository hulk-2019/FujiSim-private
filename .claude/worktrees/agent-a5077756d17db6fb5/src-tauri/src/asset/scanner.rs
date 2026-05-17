use crate::asset::{exif::ExifData, format::{self, FileKind}};
use crate::db::assets::NewAsset;
use crate::error::Result;
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

        let exif = if kind == FileKind::Image {
            crate::asset::exif::read(path).unwrap_or_default()
        } else {
            ExifData::default()
        };

        let mut width = exif.width;
        let mut height = exif.height;
        if kind == FileKind::Image && (width.is_none() || height.is_none()) {
            if let Ok(dim) = image::image_dimensions(path) {
                width = Some(dim.0 as i64);
                height = Some(dim.1 as i64);
            }
        }

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

        let exif = if kind == FileKind::Image {
            crate::asset::exif::read(path).unwrap_or_default()
        } else {
            ExifData::default()
        };

        let mut width = exif.width;
        let mut height = exif.height;
        if kind == FileKind::Image && (width.is_none() || height.is_none()) {
            if let Ok(dim) = image::image_dimensions(path) {
                width = Some(dim.0 as i64);
                height = Some(dim.1 as i64);
            }
        }

        items.push(build_asset(path, file_name, file_type, file_size, exif, width, height, kind));
    }
    Ok(ScanResult { items, skipped })
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

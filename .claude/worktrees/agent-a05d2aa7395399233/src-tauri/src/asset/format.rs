use std::path::Path;

/// 已知 RAW 格式扩展名（小写，不含 `.`）。
///
/// 覆盖主流厂商：Sony / Canon / Nikon / Fuji / Panasonic / Adobe / Olympus / Pentax / Samsung / Leica。
/// 收录原则是"市占率前列 + 公开格式文档可查"。
pub const RAW_EXT: &[&str] = &[
    "arw", "cr2", "cr3", "nef", "nrw", "raf", "rw2", "dng", "orf", "pef", "srw", "rwl", "sr2",
];

/// 通用图片格式扩展名，`image` crate 都能直接解码。
/// HEIC/HEIF 需 macOS/iOS 端的系统库配合，跨平台支持度因 image crate 版本而异。
pub const IMAGE_EXT: &[&str] = &["jpg", "jpeg", "png", "tif", "tiff", "webp", "heic", "heif"];

/// 文件归类结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    /// 主流 RAW 格式（当前 MVP 不解码，仅入库元数据）
    Raw,
    /// 通用图片格式（JPEG/PNG/TIFF 等）
    Image,
    /// 应用不感兴趣的文件，扫描时直接跳过
    Unsupported,
}

/// 根据扩展名把单个路径分类。
/// 不读取文件内容、不调用 libmagic，因为扩展名足够覆盖 99% 的相机直出文件。
pub fn classify(path: &Path) -> FileKind {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return FileKind::Unsupported;
    };
    let ext = ext.to_ascii_lowercase();
    if RAW_EXT.iter().any(|e| *e == ext) {
        FileKind::Raw
    } else if IMAGE_EXT.iter().any(|e| *e == ext) {
        FileKind::Image
    } else {
        FileKind::Unsupported
    }
}

/// 提取大写扩展名（用作 `assets.file_type` 字段，便于前端展示统一）。
pub fn ext_upper(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_uppercase())
}

//! 资产相关：目录扫描、Exif 解析、文件格式识别、物理文件操作。
//!
//! 各子模块职责：
//! - [`format`]：通过扩展名把文件分到 RAW / Image / Unsupported；
//! - [`exif`]：从 JPEG 等格式中提取拍摄元数据；
//! - [`scanner`]：递归扫描目录、生成可入库的 `NewAsset` 列表；
//! - [`fileops`]：重命名 / 移动 / 进回收站。

pub mod exif;
pub mod fileops;
pub mod format;
pub mod scanner;

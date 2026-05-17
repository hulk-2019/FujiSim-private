use crate::error::Result;
use exif::{In, Reader, Tag, Value};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

/// 一个文件的 Exif 摘要。
///
/// 所有字段都是 `Option`，因为相机/格式之间字段缺失非常常见，
/// 我们以"尽力而为"的方式提取，缺失就保持 None 而不是报错。
#[derive(Debug, Default, Clone)]
pub struct ExifData {
    pub date_taken: Option<String>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub iso: Option<i64>,
    pub f_number: Option<f64>,
    pub shutter_speed: Option<String>,
    pub focal_length: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// 从一个图片文件读取 Exif。
///
/// 失败策略：
/// - 文件根本没 Exif 段（如 PNG 不一定含）：返回 `ExifData::default()`，不当作错误；
/// - 文件 IO 失败：向上传播 `AppError::Io`；
/// - 单个字段类型不符：跳过该字段，其它字段继续提取（健壮第一）。
pub fn read(path: &Path) -> Result<ExifData> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(&file);
    let exif = match Reader::new().read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return Ok(ExifData::default()),
    };

    let mut data = ExifData::default();

    // 拍摄时间：优先 DateTimeOriginal（按下快门那一刻），否则用 DateTime（最后修改时间）
    if let Some(field) = exif.get_field(Tag::DateTimeOriginal, In::PRIMARY) {
        let s = field.display_value().to_string();
        data.date_taken = Some(normalize_datetime(&s));
    } else if let Some(field) = exif.get_field(Tag::DateTime, In::PRIMARY) {
        data.date_taken = Some(normalize_datetime(&field.display_value().to_string()));
    }

    data.camera_make = str_field(&exif, Tag::Make);
    data.camera_model = str_field(&exif, Tag::Model);
    data.lens_model = str_field(&exif, Tag::LensModel);

    // ISO：有的相机用 Short（u16），有的用 Long（u32），都收
    if let Some(field) = exif.get_field(Tag::PhotographicSensitivity, In::PRIMARY) {
        if let Value::Short(ref v) = field.value {
            if let Some(first) = v.first() {
                data.iso = Some(*first as i64);
            }
        } else if let Value::Long(ref v) = field.value {
            if let Some(first) = v.first() {
                data.iso = Some(*first as i64);
            }
        }
    }

    // 光圈：Rational 形式（如 28/10 表示 f/2.8）
    if let Some(field) = exif.get_field(Tag::FNumber, In::PRIMARY) {
        if let Value::Rational(ref r) = field.value {
            if let Some(first) = r.first() {
                if first.denom != 0 {
                    data.f_number = Some(first.num as f64 / first.denom as f64);
                }
            }
        }
    }

    // 快门：Rational（如 1/250），人类友好的字符串"1/250"
    if let Some(field) = exif.get_field(Tag::ExposureTime, In::PRIMARY) {
        if let Value::Rational(ref r) = field.value {
            if let Some(first) = r.first() {
                if first.denom != 0 {
                    let s = if first.num == 1 {
                        format!("1/{}", first.denom)
                    } else if first.num < first.denom {
                        // 例如 2/250 → 显示为 1/125
                        format!("1/{}", (first.denom as f64 / first.num as f64).round() as u32)
                    } else {
                        // 长曝光（如 30/1），直接显示秒数
                        format!("{}", first.num as f64 / first.denom as f64)
                    };
                    data.shutter_speed = Some(s);
                }
            }
        }
    }

    if let Some(field) = exif.get_field(Tag::FocalLength, In::PRIMARY) {
        if let Value::Rational(ref r) = field.value {
            if let Some(first) = r.first() {
                if first.denom != 0 {
                    data.focal_length = Some(first.num as f64 / first.denom as f64);
                }
            }
        }
    }

    if let Some(field) = exif.get_field(Tag::PixelXDimension, In::PRIMARY) {
        if let Value::Long(ref v) = field.value {
            if let Some(first) = v.first() {
                data.width = Some(*first as i64);
            }
        }
    }
    if let Some(field) = exif.get_field(Tag::PixelYDimension, In::PRIMARY) {
        if let Value::Long(ref v) = field.value {
            if let Some(first) = v.first() {
                data.height = Some(*first as i64);
            }
        }
    }

    Ok(data)
}

/// 提取字符串型 Exif 字段，并去掉 `kamadak-exif` 的 `Display` 实现外面那层引号。
fn str_field(exif: &exif::Exif, tag: Tag) -> Option<String> {
    exif.get_field(tag, In::PRIMARY).map(|f| {
        let raw = f.display_value().to_string();
        raw.trim_matches('"').trim().to_string()
    })
}

/// Exif 日期是 `YYYY:MM:DD HH:MM:SS` 格式（冒号分隔日期），
/// 转成更通用的 `YYYY-MM-DD HH:MM:SS`，方便前端排序/展示。
fn normalize_datetime(s: &str) -> String {
    let cleaned = s.trim().trim_matches('"').trim();
    if let Some((d, t)) = cleaned.split_once(' ') {
        let d = d.replace(':', "-");
        format!("{} {}", d, t)
    } else {
        cleaned.to_string()
    }
}

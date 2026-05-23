use crate::error::{AppError, Result};
use chrono::NaiveDateTime;
use std::path::{Path, PathBuf};

/// 根据模板和资产信息生成新文件名。
///
/// 支持的占位符：
/// - `{date}` → 拍摄日期 `YYYYMMDD`（无拍摄时间则用 `00000000`）
/// - `{time}` → 拍摄时刻 `HHMMSS`
/// - `{camera}` → 相机型号，空格替换为下划线
/// - `{name}` → 原文件名去掉扩展名的部分
/// - `{index}` → 批量序号（从 1 起，4 位补零）
///
/// 函数会自动在结尾补回原扩展名，不需要在模板里写 `.jpg`。
pub fn rename_with_template(
    template: &str,
    original_name: &str,
    date_taken: Option<&str>,
    camera_model: Option<&str>,
    index: usize,
) -> String {
    let stem = Path::new(original_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(original_name);
    let ext = Path::new(original_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let date_str = date_taken
        .and_then(|s| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok())
        .map(|d| d.format("%Y%m%d").to_string())
        .unwrap_or_else(|| "00000000".to_string());

    let time_str = date_taken
        .and_then(|s| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok())
        .map(|d| d.format("%H%M%S").to_string())
        .unwrap_or_else(|| "000000".to_string());

    let camera = camera_model.unwrap_or("Unknown").replace(' ', "_");

    let mut result = template
        .replace("{date}", &date_str)
        .replace("{time}", &time_str)
        .replace("{camera}", &camera)
        .replace("{name}", stem)
        .replace("{index}", &format!("{:04}", index));

    // 用户没在模板里指定扩展名时，自动补回原始扩展名
    if !ext.is_empty() && !result.ends_with(&format!(".{}", ext)) {
        result.push('.');
        result.push_str(ext);
    }
    result
}

/// 在原目录内重命名（不跨目录）。如果目标名已存在则报错，避免覆盖用户其它文件。
pub fn rename_file(old_path: &Path, new_name: &str) -> Result<PathBuf> {
    let parent = old_path
        .parent()
        .ok_or_else(|| AppError::other("invalid parent"))?;
    let new_path = parent.join(new_name);
    if new_path.exists() {
        return Err(AppError::other(format!(
            "target exists: {}",
            new_path.display()
        )));
    }
    std::fs::rename(old_path, &new_path)?;
    Ok(new_path)
}

/// 把文件物理移动到 `target_dir`。同名冲突时报错（绝不覆盖用户文件，符合 PRD 安全性要求）。
pub fn move_file(old_path: &Path, target_dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(target_dir)?;
    let file_name = old_path
        .file_name()
        .ok_or_else(|| AppError::other("invalid file name"))?;
    let new_path = target_dir.join(file_name);
    if new_path.exists() {
        return Err(AppError::other(format!(
            "target exists: {}",
            new_path.display()
        )));
    }
    std::fs::rename(old_path, &new_path)?;
    Ok(new_path)
}

/// 把文件交给系统回收站（macOS Trash / Windows 回收站 / Linux Trash 服务）。
/// 真删除是不可逆的：UI 端在调用前会做二次确认。
pub fn move_to_trash(path: &Path) -> Result<()> {
    trash::delete(path).map_err(Into::into)
}

/// 在系统文件管理器中定位并高亮文件。
/// macOS: `open -R <path>` 在 Finder 中选中文件
/// Windows: `explorer /select,<path>` 选中并高亮
/// Linux: 退化为打开父目录（多数 DE 没有标准的 select-file 协议）
pub fn reveal_in_file_manager(path: &Path) -> Result<()> {
    use std::process::Command;
    if !path.exists() {
        return Err(AppError::other(format!("path not found: {}", path.display())));
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg("-R").arg(path).spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = path
            .parent()
            .ok_or_else(|| AppError::other("invalid parent"))?;
        Command::new("xdg-open").arg(parent).spawn()?;
        Ok(())
    }
}

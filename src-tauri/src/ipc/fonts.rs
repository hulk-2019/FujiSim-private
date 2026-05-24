//! 用户字体导入与管理。

use crate::db::user_fonts;
use crate::error::{AppError, Result};
use crate::state::SharedState;
use std::path::{Path, PathBuf};
use tauri::State;

const ALLOWED_FONT_EXTS: &[&str] = &["ttf", "otf", "woff", "woff2"];

async fn unique_font_name(pool: &sqlx::SqlitePool, stem: &str) -> Result<String> {
    if !user_fonts::name_exists(pool, stem).await? {
        return Ok(stem.to_string());
    }
    for i in 2..1000 {
        let cand = format!("{stem}-{i}");
        if !user_fonts::name_exists(pool, &cand).await? {
            return Ok(cand);
        }
    }
    Err(AppError::other("too many fonts with the same name"))
}

fn unique_font_dest(dir: &Path, stem: &str, ext: &str) -> Result<PathBuf> {
    let primary = dir.join(format!("{stem}.{ext}"));
    if !primary.exists() {
        return Ok(primary);
    }
    for i in 2..1000 {
        let cand = dir.join(format!("{stem}-{i}.{ext}"));
        if !cand.exists() {
            return Ok(cand);
        }
    }
    Err(AppError::other("too many font files with the same name"))
}

#[tauri::command]
pub async fn import_fonts(
    state: State<'_, SharedState>,
    paths: Vec<String>,
) -> Result<Vec<user_fonts::UserFont>> {
    let mut out = Vec::with_capacity(paths.len());
    for raw in paths {
        let src = PathBuf::from(&raw);
        if !src.is_file() {
            tracing::warn!(?src, "import_fonts: skip non-file path");
            continue;
        }
        let ext = match src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
        {
            Some(e) if ALLOWED_FONT_EXTS.contains(&e.as_str()) => e,
            _ => {
                tracing::warn!(?src, "import_fonts: unsupported extension, skip");
                continue;
            }
        };
        let stem = src
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("font")
            .to_string();
        let display_name = match unique_font_name(&state.pool, &stem).await {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(?src, error = %e, "import_fonts: name uniqueness check failed");
                continue;
            }
        };
        let dest = match unique_font_dest(&state.font_dir, &stem, &ext) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(?src, error = %e, "import_fonts: pick dest failed");
                continue;
            }
        };
        if let Err(e) = std::fs::copy(&src, &dest) {
            tracing::warn!(?src, ?dest, error = %e, "import_fonts: copy failed");
            continue;
        }
        let dest_str = dest.to_string_lossy().to_string();
        match user_fonts::insert(&state.pool, &display_name, &dest_str, &ext).await {
            Ok(font) => out.push(font),
            Err(e) => {
                tracing::warn!(?dest, error = %e, "import_fonts: db insert failed");
                let _ = std::fs::remove_file(&dest);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_user_fonts(state: State<'_, SharedState>) -> Result<Vec<user_fonts::UserFont>> {
    user_fonts::list(&state.pool).await
}

#[tauri::command]
pub async fn delete_user_font(state: State<'_, SharedState>, id: i64) -> Result<()> {
    if let Some(path) = user_fonts::delete(&state.pool, id).await? {
        let p = PathBuf::from(&path);
        if let Err(e) = std::fs::remove_file(&p) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e.into());
            }
        }
    }
    Ok(())
}

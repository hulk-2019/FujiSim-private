//! 用户 LUT 库导入与管理。

use crate::db::user_luts;
use crate::error::{AppError, Result};
use crate::processing::lut::Lut3D;
use crate::state::SharedState;
use std::path::{Path, PathBuf};
use tauri::State;

/// 在 LUT 库中给新 LUT 选一个不冲突的显示名。
async fn unique_lut_name(pool: &sqlx::SqlitePool, stem: &str) -> Result<String> {
    if !user_luts::name_exists(pool, stem).await? {
        return Ok(stem.to_string());
    }
    for i in 2..1000 {
        let cand = format!("{stem}-{i}");
        if !user_luts::name_exists(pool, &cand).await? {
            return Ok(cand);
        }
    }
    Err(AppError::other("too many luts with the same name"))
}

/// 在 lut_dir 下给新 LUT 选一个不冲突的物理文件路径。
pub(super) fn unique_lut_dest(dir: &Path, stem: &str) -> Result<PathBuf> {
    let primary = dir.join(format!("{stem}.cube"));
    if !primary.exists() {
        return Ok(primary);
    }
    for i in 2..1000 {
        let cand = dir.join(format!("{stem}-{i}.cube"));
        if !cand.exists() {
            return Ok(cand);
        }
    }
    Err(AppError::other("too many lut files with the same name"))
}

/// 扫描目录下所有 `.cube` 文件并批量导入到用户 LUT 库。
///
/// 复用 `import_luts` 的单文件处理逻辑（校验 + 复制 + 入库），
/// 单个文件失败不阻塞其它。
#[tauri::command]
pub async fn import_luts_from_dir(
    state: State<'_, SharedState>,
    dir: String,
    category_id: Option<i64>,
) -> Result<Vec<user_luts::UserLut>> {
    let dir_path = PathBuf::from(&dir);
    if !dir_path.is_dir() {
        return Err(AppError::other("not a directory"));
    }
    let cube_paths: Vec<String> = walkdir::WalkDir::new(&dir_path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|x| x.eq_ignore_ascii_case("cube"))
                    .unwrap_or(false)
        })
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();

    // 复用已有的 import_luts 逻辑（校验 + 复制 + 入库）
    let mut out = Vec::with_capacity(cube_paths.len());
    for raw in cube_paths {
        let src = PathBuf::from(&raw);
        if let Err(e) = crate::processing::lut::Lut3D::load_cube(&src) {
            tracing::warn!(?src, error = %e, "import_luts_from_dir: invalid cube, skip");
            continue;
        }
        let stem = src
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("lut")
            .to_string();
        let display_name = match unique_lut_name(&state.pool, &stem).await {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(?src, error = %e, "import_luts_from_dir: name check failed");
                continue;
            }
        };
        let dest = match unique_lut_dest(&state.lut_dir, &stem) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(?src, error = %e, "import_luts_from_dir: pick dest failed");
                continue;
            }
        };
        if let Err(e) = std::fs::copy(&src, &dest) {
            tracing::warn!(?src, ?dest, error = %e, "import_luts_from_dir: copy failed");
            continue;
        }
        let dest_str = dest.to_string_lossy().to_string();
        match user_luts::insert(&state.pool, &display_name, &dest_str, category_id).await {
            Ok(lut) => out.push(lut),
            Err(e) => {
                tracing::warn!(?dest, error = %e, "import_luts_from_dir: db insert failed");
                let _ = std::fs::remove_file(&dest);
            }
        }
    }
    Ok(out)
}

/// 对每个路径：先用 [`Lut3D::load_cube`] 校验合法，再把文件**复制**到应用数据目录
/// `<data_dir>/luts/` 下，最后落库 `user_luts`。文件名或显示名冲突时会自动追加
/// `-{n}` 后缀（互不影响）。
///
/// 单个文件失败不中断整批：用 tracing 记录错误并跳过，最终只返回成功入库的条目。
#[tauri::command]
pub async fn import_luts(
    state: State<'_, SharedState>,
    paths: Vec<String>,
    category_id: Option<i64>,
) -> Result<Vec<user_luts::UserLut>> {
    let mut out = Vec::with_capacity(paths.len());
    for raw in paths {
        let src = PathBuf::from(&raw);
        if !src.is_file() {
            tracing::warn!(?src, "import_luts: skip non-file path");
            continue;
        }
        // 校验 .cube 合法（解析失败直接跳过，避免污染 LUT 库）
        if let Err(e) = Lut3D::load_cube(&src) {
            tracing::warn!(?src, error = %e, "import_luts: invalid cube, skip");
            continue;
        }

        let stem = src
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("lut")
            .to_string();
        let display_name = match unique_lut_name(&state.pool, &stem).await {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(?src, error = %e, "import_luts: name uniqueness check failed");
                continue;
            }
        };

        let dest = match unique_lut_dest(&state.lut_dir, &stem) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(?src, error = %e, "import_luts: pick dest failed");
                continue;
            }
        };
        if let Err(e) = std::fs::copy(&src, &dest) {
            tracing::warn!(?src, ?dest, error = %e, "import_luts: copy failed");
            continue;
        }

        let dest_str = dest.to_string_lossy().to_string();
        match user_luts::insert(&state.pool, &display_name, &dest_str, category_id).await {
            Ok(lut) => out.push(lut),
            Err(e) => {
                tracing::warn!(?dest, error = %e, "import_luts: db insert failed");
                let _ = std::fs::remove_file(&dest);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_user_luts(state: State<'_, SharedState>) -> Result<Vec<user_luts::UserLut>> {
    user_luts::list(&state.pool).await
}

#[tauri::command]
pub async fn delete_user_lut(state: State<'_, SharedState>, id: i64) -> Result<()> {
    if let Some(path) = user_luts::delete(&state.pool, id).await? {
        let p = PathBuf::from(&path);
        // 同步把内存里缓存的 Lut3D 也清掉，避免被释放的 LUT 仍占着堆
        if let Ok(mut cache) = state.lut_cache.lock() {
            cache.remove(&p);
        }
        // 容忍文件已经手动删除：只有"非 NotFound" 的 IO 错误才向上抛
        if let Err(e) = std::fs::remove_file(&p) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e.into());
            }
        }
    }
    Ok(())
}

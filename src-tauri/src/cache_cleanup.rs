use crate::db::assets::Asset;
use crate::state::SharedState;
use std::path::{Path, PathBuf};

pub fn delete_asset_cache_files(state: &SharedState, asset: &Asset) {
    delete_asset_cache_files_by_id(state, asset.id, asset.cover_path.as_deref());
}

pub fn delete_asset_cache_files_by_id(
    state: &SharedState,
    asset_id: i64,
    known_cover_path: Option<&str>,
) {
    if let Some(path) = known_cover_path {
        remove_file_if_exists(Path::new(path));
    }

    let cover_name = format!("{asset_id}.jpg");
    remove_scoped_file_variants(&state.cover_dir, &cover_name);

    let preview_base_name = format!("{asset_id}_baseline.tif");
    remove_scoped_file_variants(&state.raw_original_dir, &preview_base_name);

    if let Ok(mut cache) = state.preview_base_cache.lock() {
        cache.remove_asset(asset_id);
    }
}

pub fn delete_project_cache_dirs(state: &SharedState, project_id: i64) {
    remove_dir_if_exists(project_cache_dir(&state.cover_dir, project_id));
    remove_dir_if_exists(project_cache_dir(&state.raw_original_dir, project_id));

    if let Ok(mut cache) = state.preview_base_cache.lock() {
        cache.clear();
    }
}

pub fn delete_project_asset_cache_files(state: &SharedState, project_id: i64, asset_id: i64) {
    remove_file_if_exists(
        &project_cache_dir(&state.cover_dir, project_id).join(format!("{asset_id}.jpg")),
    );
    remove_file_if_exists(
        &project_cache_dir(&state.raw_original_dir, project_id)
            .join(format!("{asset_id}_baseline.tif")),
    );

    if let Ok(mut cache) = state.preview_base_cache.lock() {
        cache.remove_asset(asset_id);
    }
}

fn remove_scoped_file_variants(base_dir: &Path, file_name: &str) {
    remove_file_if_exists(&base_dir.join(file_name));

    let Ok(entries) = std::fs::read_dir(base_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("project_") {
            continue;
        }
        remove_file_if_exists(&entry.path().join(file_name));
    }
}

fn project_cache_dir(base_dir: &Path, project_id: i64) -> PathBuf {
    base_dir.join(format!("project_{project_id}"))
}

fn remove_file_if_exists(path: &Path) {
    if !path.exists() {
        return;
    }
    if let Err(e) = std::fs::remove_file(path) {
        tracing::warn!(path = %path.display(), error = %e, "failed to remove cache file");
    }
}

fn remove_dir_if_exists(path: PathBuf) {
    if !path.exists() {
        return;
    }
    if let Err(e) = std::fs::remove_dir_all(&path) {
        tracing::warn!(path = %path.display(), error = %e, "failed to remove cache directory");
    }
}

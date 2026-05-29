use crate::db::assets::Asset;
use crate::state::SharedState;
use std::path::Path;

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

    remove_file_if_exists(&state.project_cover_dir.join(format!("{asset_id}.jpg")));

    if let Ok(mut cache) = state.preview_base_cache.lock() {
        cache.remove_asset(asset_id);
    }
}

pub fn delete_project_cache_dirs(state: &SharedState, _project_id: i64) {
    if let Ok(mut cache) = state.preview_base_cache.lock() {
        cache.clear();
    }
}

pub fn delete_project_asset_cache_files(state: &SharedState, _project_id: i64, asset_id: i64) {
    if let Ok(mut cache) = state.preview_base_cache.lock() {
        cache.remove_asset(asset_id);
    }
}

fn remove_file_if_exists(path: &Path) {
    if !path.exists() {
        return;
    }
    if let Err(e) = std::fs::remove_file(path) {
        tracing::warn!(path = %path.display(), error = %e, "failed to remove cache file");
    }
}

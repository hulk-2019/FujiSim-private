//! 相册 CRUD、汇总信息和回收站。

use crate::db::{assets, projects};
use crate::error::Result;
use crate::state::SharedState;
use tauri::State;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProjectSummary {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub is_deleted: i64,
    pub deleted_at: Option<String>,
    pub total: i64,
    pub cover_paths: Vec<String>,
}

#[tauri::command]
pub async fn list_projects(state: State<'_, SharedState>) -> Result<Vec<projects::Project>> {
    projects::list(&state.pool).await
}

#[tauri::command]
pub async fn create_project(state: State<'_, SharedState>, name: String) -> Result<projects::Project> {
    projects::create(&state.pool, &name).await
}

#[tauri::command]
pub async fn delete_project(state: State<'_, SharedState>, id: i64) -> Result<()> {
    projects::delete(&state.pool, id).await
        .map(|_| crate::cache_cleanup::delete_project_cache_dirs(&state, id))
}

#[tauri::command]
pub async fn check_project_name_exists(
    state: State<'_, SharedState>,
    name: String,
    exclude_id: Option<i64>,
) -> Result<bool> {
    projects::name_exists(&state.pool, &name, exclude_id).await
}

#[tauri::command]
pub async fn rename_project(
    state: State<'_, SharedState>,
    id: i64,
    name: String,
) -> Result<projects::Project> {
    projects::rename(&state.pool, id, &name).await
}

#[tauri::command]
pub async fn get_folder_asset_count(state: State<'_, SharedState>, id: i64) -> Result<i64> {
    projects::asset_count(&state.pool, id).await
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, SharedState>, id: i64) -> Result<()> {
    projects::delete_with_assets(&state.pool, id).await?;
    crate::cache_cleanup::delete_project_cache_dirs(&state, id);
    Ok(())
}

#[tauri::command]
pub async fn project_add(
    state: State<'_, SharedState>,
    project_id: i64,
    asset_ids: Vec<i64>,
) -> Result<()> {
    projects::add_assets(&state.pool, project_id, &asset_ids).await
}

#[tauri::command]
pub async fn project_remove(
    state: State<'_, SharedState>,
    project_id: i64,
    asset_ids: Vec<i64>,
) -> Result<()> {
    projects::remove_assets(&state.pool, project_id, &asset_ids).await?;
    for asset_id in asset_ids {
        crate::cache_cleanup::delete_project_asset_cache_files(&state, project_id, asset_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_project_summaries(state: State<'_, SharedState>) -> Result<Vec<ProjectSummary>> {
    let projects = projects::list(&state.pool).await?;
    build_project_summaries(&state.pool, projects).await
}

/// 给定一组 project，批量查询每个相册的资产数量和前 4 张封面（按拍摄时间倒序），
/// 组装成 [`ProjectSummary`] 列表。get_project_summaries 和 list_trash_projects 共用。
async fn build_project_summaries(
    pool: &sqlx::SqlitePool,
    projects: Vec<projects::Project>,
) -> Result<Vec<ProjectSummary>> {
    if projects.is_empty() {
        return Ok(vec![]);
    }

    // 一次查询所有相册的资产数量
    let totals: Vec<(i64, i64)> =
        sqlx::query_as("SELECT project_id, COUNT(*) as cnt FROM project_assets GROUP BY project_id")
            .fetch_all(pool)
            .await?;
    let total_map: std::collections::HashMap<i64, i64> = totals.into_iter().collect();

    // 一次查询所有相册的前4张封面（用 ROW_NUMBER 窗口函数）
    let cover_rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT project_id, path FROM ( \
            SELECT aa.project_id, COALESCE(a.cover_path, a.file_path) as path, \
                   ROW_NUMBER() OVER (PARTITION BY aa.project_id ORDER BY a.date_taken DESC) as rn \
            FROM project_assets aa \
            JOIN assets a ON a.id = aa.asset_id \
        ) WHERE rn <= 4",
    )
    .fetch_all(pool)
    .await?;

    let mut cover_map: std::collections::HashMap<i64, Vec<String>> =
        std::collections::HashMap::new();
    for (project_id, path) in cover_rows {
        cover_map.entry(project_id).or_default().push(path);
    }

    let summaries = projects
        .into_iter()
        .map(|project| {
            let total = total_map.get(&project.id).copied().unwrap_or(0);
            let cover_paths = cover_map.remove(&project.id).unwrap_or_default();
            ProjectSummary {
                id: project.id,
                name: project.name,
                created_at: project.created_at,
                is_deleted: project.is_deleted,
                deleted_at: project.deleted_at,
                total,
                cover_paths,
            }
        })
        .collect();
    Ok(summaries)
}

#[tauri::command]
pub async fn list_trash_projects(state: State<'_, SharedState>) -> Result<Vec<ProjectSummary>> {
    let projects = projects::list_trash(&state.pool).await?;
    build_project_summaries(&state.pool, projects).await
}

#[tauri::command]
pub async fn restore_project(state: State<'_, SharedState>, id: i64) -> Result<()> {
    projects::restore(&state.pool, id).await
}

#[tauri::command]
pub async fn purge_project(state: State<'_, SharedState>, id: i64) -> Result<()> {
    let assets_to_purge = assets::orphaned_for_trashed_project(&state.pool, id).await?;
    projects::purge(&state.pool, id).await
        .map(|_| {
            for asset in &assets_to_purge {
                crate::cache_cleanup::delete_asset_cache_files(&state, asset);
            }
            crate::cache_cleanup::delete_project_cache_dirs(&state, id);
        })
}

#[tauri::command]
pub async fn purge_all_trash(state: State<'_, SharedState>) -> Result<()> {
    let assets_to_purge = assets::orphaned_for_all_trashed_projects(&state.pool).await?;
    let trashed_projects = projects::list_trash(&state.pool).await?;
    projects::purge_all(&state.pool).await
        .map(|_| {
            for asset in &assets_to_purge {
                crate::cache_cleanup::delete_asset_cache_files(&state, asset);
            }
            for project in &trashed_projects {
                crate::cache_cleanup::delete_project_cache_dirs(&state, project.id);
            }
        })
}

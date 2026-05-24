//! 相册 CRUD、汇总信息和回收站。

use crate::db::albums;
use crate::error::Result;
use crate::state::SharedState;
use tauri::State;

#[derive(Debug, Clone, serde::Serialize)]
pub struct AlbumSummary {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub is_deleted: i64,
    pub deleted_at: Option<String>,
    pub total: i64,
    pub cover_paths: Vec<String>,
}

#[tauri::command]
pub async fn list_albums(state: State<'_, SharedState>) -> Result<Vec<albums::Album>> {
    albums::list(&state.pool).await
}

#[tauri::command]
pub async fn create_album(state: State<'_, SharedState>, name: String) -> Result<albums::Album> {
    albums::create(&state.pool, &name).await
}

#[tauri::command]
pub async fn delete_album(state: State<'_, SharedState>, id: i64) -> Result<()> {
    albums::delete(&state.pool, id).await
}

#[tauri::command]
pub async fn check_album_name_exists(
    state: State<'_, SharedState>,
    name: String,
    exclude_id: Option<i64>,
) -> Result<bool> {
    albums::name_exists(&state.pool, &name, exclude_id).await
}

#[tauri::command]
pub async fn rename_album(
    state: State<'_, SharedState>,
    id: i64,
    name: String,
) -> Result<albums::Album> {
    albums::rename(&state.pool, id, &name).await
}

#[tauri::command]
pub async fn get_folder_asset_count(state: State<'_, SharedState>, id: i64) -> Result<i64> {
    albums::asset_count(&state.pool, id).await
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, SharedState>, id: i64) -> Result<()> {
    albums::delete_with_assets(&state.pool, id).await?;
    Ok(())
}

#[tauri::command]
pub async fn album_add(
    state: State<'_, SharedState>,
    album_id: i64,
    asset_ids: Vec<i64>,
) -> Result<()> {
    albums::add_assets(&state.pool, album_id, &asset_ids).await
}

#[tauri::command]
pub async fn album_remove(
    state: State<'_, SharedState>,
    album_id: i64,
    asset_ids: Vec<i64>,
) -> Result<()> {
    albums::remove_assets(&state.pool, album_id, &asset_ids).await
}

#[tauri::command]
pub async fn get_album_summaries(state: State<'_, SharedState>) -> Result<Vec<AlbumSummary>> {
    let albums = albums::list(&state.pool).await?;
    build_album_summaries(&state.pool, albums).await
}

/// 给定一组 album，批量查询每个相册的资产数量和前 4 张封面（按拍摄时间倒序），
/// 组装成 [`AlbumSummary`] 列表。get_album_summaries 和 list_trash_albums 共用。
async fn build_album_summaries(
    pool: &sqlx::SqlitePool,
    albums: Vec<albums::Album>,
) -> Result<Vec<AlbumSummary>> {
    if albums.is_empty() {
        return Ok(vec![]);
    }

    // 一次查询所有相册的资产数量
    let totals: Vec<(i64, i64)> =
        sqlx::query_as("SELECT album_id, COUNT(*) as cnt FROM album_assets GROUP BY album_id")
            .fetch_all(pool)
            .await?;
    let total_map: std::collections::HashMap<i64, i64> = totals.into_iter().collect();

    // 一次查询所有相册的前4张封面（用 ROW_NUMBER 窗口函数）
    let cover_rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT album_id, path FROM ( \
            SELECT aa.album_id, COALESCE(a.cover_path, a.file_path) as path, \
                   ROW_NUMBER() OVER (PARTITION BY aa.album_id ORDER BY a.date_taken DESC) as rn \
            FROM album_assets aa \
            JOIN assets a ON a.id = aa.asset_id \
        ) WHERE rn <= 4",
    )
    .fetch_all(pool)
    .await?;

    let mut cover_map: std::collections::HashMap<i64, Vec<String>> =
        std::collections::HashMap::new();
    for (album_id, path) in cover_rows {
        cover_map.entry(album_id).or_default().push(path);
    }

    let summaries = albums
        .into_iter()
        .map(|album| {
            let total = total_map.get(&album.id).copied().unwrap_or(0);
            let cover_paths = cover_map.remove(&album.id).unwrap_or_default();
            AlbumSummary {
                id: album.id,
                name: album.name,
                created_at: album.created_at,
                is_deleted: album.is_deleted,
                deleted_at: album.deleted_at,
                total,
                cover_paths,
            }
        })
        .collect();
    Ok(summaries)
}

#[tauri::command]
pub async fn list_trash_albums(state: State<'_, SharedState>) -> Result<Vec<AlbumSummary>> {
    let albums = albums::list_trash(&state.pool).await?;
    build_album_summaries(&state.pool, albums).await
}

#[tauri::command]
pub async fn restore_album(state: State<'_, SharedState>, id: i64) -> Result<()> {
    albums::restore(&state.pool, id).await
}

#[tauri::command]
pub async fn purge_album(state: State<'_, SharedState>, id: i64) -> Result<()> {
    albums::purge(&state.pool, id).await
}

#[tauri::command]
pub async fn purge_all_trash(state: State<'_, SharedState>) -> Result<()> {
    albums::purge_all(&state.pool).await
}

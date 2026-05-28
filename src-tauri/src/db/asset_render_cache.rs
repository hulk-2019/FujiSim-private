use crate::error::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AssetRenderCacheEntry {
    pub asset_id: i64,
    pub cache_kind: String,
    pub cache_key: String,
    pub path: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub pipeline_version: i64,
    pub filter_hash: Option<String>,
    pub created_at: String,
    pub last_accessed_at: String,
}

pub async fn get(
    pool: &SqlitePool,
    asset_id: i64,
    cache_kind: &str,
    cache_key: &str,
) -> Result<Option<AssetRenderCacheEntry>> {
    let entry = sqlx::query_as::<_, AssetRenderCacheEntry>(
        r#"
        SELECT *
        FROM asset_render_cache
        WHERE asset_id = ? AND cache_kind = ? AND cache_key = ?
        "#,
    )
    .bind(asset_id)
    .bind(cache_kind)
    .bind(cache_key)
    .fetch_optional(pool)
    .await?;

    if entry.is_some() {
        touch(pool, asset_id, cache_kind, cache_key).await?;
    }

    Ok(entry)
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert(
    pool: &SqlitePool,
    asset_id: i64,
    cache_kind: &str,
    cache_key: &str,
    path: &str,
    width: Option<i64>,
    height: Option<i64>,
    pipeline_version: i64,
    filter_hash: Option<&str>,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO asset_render_cache
            (asset_id, cache_kind, cache_key, path, width, height, pipeline_version, filter_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id, cache_kind, cache_key) DO UPDATE SET
            path = excluded.path,
            width = excluded.width,
            height = excluded.height,
            pipeline_version = excluded.pipeline_version,
            filter_hash = excluded.filter_hash,
            last_accessed_at = datetime('now')
        "#,
    )
    .bind(asset_id)
    .bind(cache_kind)
    .bind(cache_key)
    .bind(path)
    .bind(width)
    .bind(height)
    .bind(pipeline_version)
    .bind(filter_hash)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn touch(
    pool: &SqlitePool,
    asset_id: i64,
    cache_kind: &str,
    cache_key: &str,
) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE asset_render_cache
        SET last_accessed_at = datetime('now')
        WHERE asset_id = ? AND cache_kind = ? AND cache_key = ?
        "#,
    )
    .bind(asset_id)
    .bind(cache_kind)
    .bind(cache_key)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_kind(pool: &SqlitePool, cache_kind: &str) -> Result<()> {
    sqlx::query("DELETE FROM asset_render_cache WHERE cache_kind = ?")
        .bind(cache_kind)
        .execute(pool)
        .await?;
    Ok(())
}

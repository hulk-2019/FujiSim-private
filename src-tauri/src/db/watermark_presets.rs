use crate::error::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct WatermarkPreset {
    pub id: i64,
    pub name: String,
    pub settings_json: String,
    pub created_at: String,
    pub is_deleted: i64,
    pub deleted_at: Option<String>,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<WatermarkPreset>> {
    sqlx::query_as::<_, WatermarkPreset>(
        "SELECT * FROM watermark_presets WHERE is_deleted = 0 ORDER BY created_at ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn create(pool: &SqlitePool, name: &str, settings_json: &str) -> Result<WatermarkPreset> {
    sqlx::query("INSERT INTO watermark_presets (name, settings_json) VALUES (?, ?)")
        .bind(name)
        .bind(settings_json)
        .execute(pool)
        .await?;
    sqlx::query_as::<_, WatermarkPreset>(
        "SELECT * FROM watermark_presets WHERE name = ? AND is_deleted = 0",
    )
    .bind(name)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

pub async fn update(pool: &SqlitePool, id: i64, name: &str, settings_json: &str) -> Result<WatermarkPreset> {
    sqlx::query(
        "UPDATE watermark_presets SET name = ?, settings_json = ? WHERE id = ? AND is_deleted = 0",
    )
    .bind(name)
    .bind(settings_json)
    .bind(id)
    .execute(pool)
    .await?;
    sqlx::query_as::<_, WatermarkPreset>("SELECT * FROM watermark_presets WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// 软删除：标记 is_deleted=1，保留记录。
pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query(
        "UPDATE watermark_presets SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

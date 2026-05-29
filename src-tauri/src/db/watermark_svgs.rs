use crate::error::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserWatermarkSvg {
    pub id: i64,
    pub name: String,
    pub file_path: String,
    pub preview_svg: Option<String>,
    pub created_at: String,
    pub is_deleted: i64,
    pub deleted_at: Option<String>,
}

pub async fn insert(
    pool: &SqlitePool,
    name: &str,
    file_path: &str,
    preview_svg: Option<&str>,
) -> Result<UserWatermarkSvg> {
    sqlx::query(
        r#"INSERT INTO user_watermark_svgs (name, file_path, preview_svg) VALUES (?, ?, ?)
           ON CONFLICT(file_path) DO UPDATE SET name = excluded.name, preview_svg = excluded.preview_svg, is_deleted = 0, deleted_at = NULL"#,
    )
    .bind(name)
    .bind(file_path)
    .bind(preview_svg)
    .execute(pool)
    .await?;
    sqlx::query_as::<_, UserWatermarkSvg>("SELECT * FROM user_watermark_svgs WHERE file_path = ?")
        .bind(file_path)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<UserWatermarkSvg>> {
    sqlx::query_as::<_, UserWatermarkSvg>(
        "SELECT * FROM user_watermark_svgs WHERE is_deleted = 0 ORDER BY name ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT file_path FROM user_watermark_svgs WHERE id = ? AND is_deleted = 0")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    sqlx::query("UPDATE user_watermark_svgs SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(row.map(|(p,)| p))
}

pub async fn delete_all(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "UPDATE user_watermark_svgs SET is_deleted = 1, deleted_at = datetime('now') WHERE is_deleted = 0",
    )
    .execute(pool)
    .await?;
    Ok(())
}

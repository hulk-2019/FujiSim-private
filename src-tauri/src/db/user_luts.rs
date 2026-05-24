use crate::error::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserLut {
    pub id: i64,
    pub name: String,
    pub file_path: String,
    pub created_at: String,
    pub is_deleted: i64,
    pub deleted_at: Option<String>,
}

pub async fn insert(pool: &SqlitePool, name: &str, file_path: &str) -> Result<UserLut> {
    sqlx::query(
        r#"INSERT INTO user_luts (name, file_path) VALUES (?, ?)
           ON CONFLICT(file_path) DO UPDATE SET name = excluded.name, is_deleted = 0, deleted_at = NULL"#,
    )
    .bind(name)
    .bind(file_path)
    .execute(pool)
    .await?;
    sqlx::query_as::<_, UserLut>("SELECT * FROM user_luts WHERE file_path = ?")
        .bind(file_path)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<UserLut>> {
    sqlx::query_as::<_, UserLut>("SELECT * FROM user_luts WHERE is_deleted = 0 ORDER BY name ASC")
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

/// 软删除：标记 is_deleted=1，保留记录和物理文件路径。
pub async fn delete(pool: &SqlitePool, id: i64) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT file_path FROM user_luts WHERE id = ? AND is_deleted = 0")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    sqlx::query("UPDATE user_luts SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(row.map(|(p,)| p))
}

pub async fn name_exists(pool: &SqlitePool, name: &str) -> Result<bool> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM user_luts WHERE name = ? AND is_deleted = 0 LIMIT 1")
            .bind(name)
            .fetch_optional(pool)
            .await?;
    Ok(row.is_some())
}

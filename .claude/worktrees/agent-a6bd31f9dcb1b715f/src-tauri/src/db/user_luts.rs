use crate::error::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

/// 用户导入的 3D LUT 库条目。
///
/// `file_path` 指向应用数据目录下 `luts/` 子目录中的 `.cube` 副本（导入时拷贝进来），
/// 因此源文件的移动或删除不会影响应用。`name` 是去重后的展示名（不含扩展名）。
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserLut {
    pub id: i64,
    pub name: String,
    pub file_path: String,
    pub created_at: String,
}

pub async fn insert(pool: &SqlitePool, name: &str, file_path: &str) -> Result<UserLut> {
    sqlx::query(
        r#"INSERT INTO user_luts (name, file_path) VALUES (?, ?)
           ON CONFLICT(file_path) DO UPDATE SET name = excluded.name"#,
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
    sqlx::query_as::<_, UserLut>("SELECT * FROM user_luts ORDER BY name ASC")
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

/// 删除一条 LUT 记录，返回原 `file_path` 供调用方做物理文件清理。
pub async fn delete(pool: &SqlitePool, id: i64) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT file_path FROM user_luts WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    sqlx::query("DELETE FROM user_luts WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(row.map(|(p,)| p))
}

/// 检查某个 LUT 名字是否已存在（用于导入时去重）。
pub async fn name_exists(pool: &SqlitePool, name: &str) -> Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM user_luts WHERE name = ? LIMIT 1")
        .bind(name)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}

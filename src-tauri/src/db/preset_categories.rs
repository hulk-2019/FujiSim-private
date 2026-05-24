use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

/// 用户自定义预设分类的读模型。
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PresetCategory {
    pub id: i64,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<PresetCategory>> {
    sqlx::query_as::<_, PresetCategory>(
        "SELECT * FROM preset_categories ORDER BY sort_order ASC, name ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn name_exists(pool: &SqlitePool, name: &str, exclude_id: Option<i64>) -> Result<bool> {
    let count: (i64,) = match exclude_id {
        Some(eid) => {
            sqlx::query_as("SELECT COUNT(*) FROM preset_categories WHERE name = ? AND id != ?")
                .bind(name)
                .bind(eid)
                .fetch_one(pool)
                .await?
        }
        None => {
            sqlx::query_as("SELECT COUNT(*) FROM preset_categories WHERE name = ?")
                .bind(name)
                .fetch_one(pool)
                .await?
        }
    };
    Ok(count.0 > 0)
}

pub async fn create(pool: &SqlitePool, name: &str) -> Result<PresetCategory> {
    if name_exists(pool, name, None).await? {
        return Err(AppError::other("该分类名已存在"));
    }
    let id = sqlx::query("INSERT INTO preset_categories (name) VALUES (?)")
        .bind(name)
        .execute(pool)
        .await?
        .last_insert_rowid();
    sqlx::query_as::<_, PresetCategory>("SELECT * FROM preset_categories WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn rename(pool: &SqlitePool, id: i64, name: &str) -> Result<PresetCategory> {
    if name_exists(pool, name, Some(id)).await? {
        return Err(AppError::other("该分类名已存在"));
    }
    let result = sqlx::query("UPDATE preset_categories SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound.into());
    }
    sqlx::query_as::<_, PresetCategory>("SELECT * FROM preset_categories WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// 删除分类。事务中先把 filter_presets / user_luts 的 category_id 置 NULL，
/// 再 DELETE，保证内容物只迁移分组、不删除。
pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE filter_presets SET category_id = NULL WHERE category_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE user_luts SET category_id = NULL WHERE category_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM preset_categories WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fresh_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create in-memory pool");
        sqlx::query(
            r#"
            CREATE TABLE preset_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE filter_presets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id INTEGER
            );
            CREATE TABLE user_luts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id INTEGER
            );
            "#,
        )
        .execute(&pool)
        .await
        .expect("seed schema");
        pool
    }

    #[tokio::test]
    async fn create_and_list() {
        let pool = fresh_pool().await;
        let c = create(&pool, "合照").await.expect("create");
        assert_eq!(c.name, "合照");
        let all = list(&pool).await.expect("list");
        assert_eq!(all.len(), 1);
    }

    #[tokio::test]
    async fn create_duplicate_returns_error() {
        let pool = fresh_pool().await;
        create(&pool, "合照").await.expect("create");
        let err = create(&pool, "合照").await.expect_err("should fail");
        assert!(err.to_string().contains("已存在"));
    }

    #[tokio::test]
    async fn rename_collides_with_other() {
        let pool = fresh_pool().await;
        let _a = create(&pool, "合照").await.expect("create a");
        let b = create(&pool, "胶片日记").await.expect("create b");
        let err = rename(&pool, b.id, "合照").await.expect_err("should fail");
        assert!(err.to_string().contains("已存在"));
    }

    #[tokio::test]
    async fn rename_to_self_ok() {
        let pool = fresh_pool().await;
        let a = create(&pool, "合照").await.expect("create");
        rename(&pool, a.id, "合照")
            .await
            .expect("rename to self ok");
    }

    #[tokio::test]
    async fn delete_clears_foreign_refs() {
        let pool = fresh_pool().await;
        let c = create(&pool, "合照").await.expect("create");
        sqlx::query("INSERT INTO filter_presets (category_id) VALUES (?)")
            .bind(c.id)
            .execute(&pool)
            .await
            .expect("insert preset");
        sqlx::query("INSERT INTO user_luts (category_id) VALUES (?)")
            .bind(c.id)
            .execute(&pool)
            .await
            .expect("insert lut");
        delete(&pool, c.id).await.expect("delete");
        let preset_cat: (Option<i64>,) =
            sqlx::query_as("SELECT category_id FROM filter_presets LIMIT 1")
                .fetch_one(&pool)
                .await
                .expect("query preset");
        let lut_cat: (Option<i64>,) = sqlx::query_as("SELECT category_id FROM user_luts LIMIT 1")
            .fetch_one(&pool)
            .await
            .expect("query lut");
        assert_eq!(preset_cat.0, None);
        assert_eq!(lut_cat.0, None);
        assert!(list(&pool).await.expect("list").is_empty());
    }

    #[tokio::test]
    async fn name_exists_with_exclude() {
        let pool = fresh_pool().await;
        let a = create(&pool, "合照").await.expect("create");
        assert!(!name_exists(&pool, "合照", Some(a.id)).await.expect("check"));
        assert!(name_exists(&pool, "合照", None).await.expect("check"));
    }
}

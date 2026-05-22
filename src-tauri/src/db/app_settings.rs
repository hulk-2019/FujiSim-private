//! 应用设置 KV 存储。
//!
//! 用于持久化用户偏好（主题、语言、更新检查策略等）。
//! key 命名约定参见 `docs/superpowers/specs/2026-05-22-auto-update-codesigning-settings-design.md` 第 6.3 节。

use crate::error::Result;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// 取单个设置值。返回 `None` 表示该 key 从未被设置。
pub async fn get(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM app_settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(v,)| v))
}

/// 写入或更新设置值。`updated_at` 自动维护为当前 unix 时间戳。
pub async fn set(pool: &SqlitePool, key: &str, value: &str) -> Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    sqlx::query(
        r#"
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        "#,
    )
    .bind(key)
    .bind(value)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// 删除某个设置项。删除不存在的 key 不视为错误。
pub async fn delete(pool: &SqlitePool, key: &str) -> Result<()> {
    sqlx::query("DELETE FROM app_settings WHERE key = ?1")
        .bind(key)
        .execute(pool)
        .await?;
    Ok(())
}

/// 一次性读取所有设置项，返回 key->value HashMap。前端启动时调用，避免 N 次 IPC。
pub async fn get_all(pool: &SqlitePool) -> Result<HashMap<String, String>> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM app_settings")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("memory pool");
        sqlx::query(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
        )
        .execute(&pool)
        .await
        .expect("create table");
        pool
    }

    #[tokio::test]
    async fn get_returns_none_for_missing_key() {
        let pool = test_pool().await;
        assert_eq!(get(&pool, "missing").await.expect("get"), None);
    }

    #[tokio::test]
    async fn set_then_get_roundtrip() {
        let pool = test_pool().await;
        set(&pool, "ui.theme", "dark").await.expect("set");
        assert_eq!(
            get(&pool, "ui.theme").await.expect("get"),
            Some("dark".to_string())
        );
    }

    #[tokio::test]
    async fn set_overwrites_existing() {
        let pool = test_pool().await;
        set(&pool, "ui.theme", "light").await.expect("set 1");
        set(&pool, "ui.theme", "dark").await.expect("set 2");
        assert_eq!(
            get(&pool, "ui.theme").await.expect("get"),
            Some("dark".to_string())
        );
    }

    #[tokio::test]
    async fn delete_removes_key() {
        let pool = test_pool().await;
        set(&pool, "ui.theme", "dark").await.expect("set");
        delete(&pool, "ui.theme").await.expect("delete");
        assert_eq!(get(&pool, "ui.theme").await.expect("get"), None);
    }

    #[tokio::test]
    async fn get_all_returns_empty_when_no_settings() {
        let pool = test_pool().await;
        assert!(get_all(&pool).await.expect("get_all").is_empty());
    }

    #[tokio::test]
    async fn get_all_returns_all_settings() {
        let pool = test_pool().await;
        set(&pool, "ui.theme", "dark").await.expect("set 1");
        set(&pool, "ui.language", "en").await.expect("set 2");
        let all = get_all(&pool).await.expect("get_all");
        assert_eq!(all.len(), 2);
        assert_eq!(all.get("ui.theme"), Some(&"dark".to_string()));
        assert_eq!(all.get("ui.language"), Some(&"en".to_string()));
    }
}

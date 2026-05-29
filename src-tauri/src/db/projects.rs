use crate::error::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

/// 虚拟相册的读模型。
///
/// 相册与资产是多对多（通过 `project_assets` 关联表），删除相册时关联表行因
/// `ON DELETE CASCADE` 自动清理，但**不**会删除 `assets` 表里的资产记录。
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub is_deleted: i64,
    pub deleted_at: Option<String>,
}

/// 创建相册。`name` 字段 UNIQUE，重名会返回 SQL 错误。
pub async fn create(pool: &SqlitePool, name: &str) -> Result<Project> {
    let id = sqlx::query("INSERT INTO projects (name) VALUES (?)")
        .bind(name)
        .execute(pool)
        .await?
        .last_insert_rowid();
    sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Project>> {
    sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE is_deleted = 0 ORDER BY name")
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("UPDATE projects SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 批量把资产加入相册。使用事务保证全部成功或全部失败，
/// `ON CONFLICT DO NOTHING` 让重复关联是幂等的。
pub async fn add_assets(pool: &SqlitePool, project_id: i64, asset_ids: &[i64]) -> Result<()> {
    let mut tx = pool.begin().await?;
    for aid in asset_ids {
        sqlx::query(
            "INSERT INTO project_assets (project_id, asset_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(project_id)
        .bind(aid)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 批量从相册中移除资产关联（不删除资产本身）。
pub async fn remove_assets(pool: &SqlitePool, project_id: i64, asset_ids: &[i64]) -> Result<()> {
    let mut tx = pool.begin().await?;
    for aid in asset_ids {
        sqlx::query("DELETE FROM project_assets WHERE project_id = ? AND asset_id = ?")
            .bind(project_id)
            .bind(aid)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 检查名称是否已存在。`exclude_id` 用于重命名时排除自身。
pub async fn name_exists(pool: &SqlitePool, name: &str, exclude_id: Option<i64>) -> Result<bool> {
    let count: (i64,) = match exclude_id {
        Some(eid) => {
            sqlx::query_as(
                "SELECT COUNT(*) FROM projects WHERE name = ? AND id != ? AND is_deleted = 0",
            )
            .bind(name)
            .bind(eid)
            .fetch_one(pool)
            .await?
        }
        None => {
            sqlx::query_as("SELECT COUNT(*) FROM projects WHERE name = ? AND is_deleted = 0")
                .bind(name)
                .fetch_one(pool)
                .await?
        }
    };
    Ok(count.0 > 0)
}

pub async fn rename(pool: &SqlitePool, id: i64, name: &str) -> Result<Project> {
    let result = sqlx::query("UPDATE projects SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound.into());
    }
    sqlx::query_as::<_, Project>("SELECT * FROM projects WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// 查询文件夹内资产数量（用于删除确认弹框）。
pub async fn asset_count(pool: &SqlitePool, id: i64) -> Result<i64> {
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM project_assets WHERE project_id = ?")
            .bind(id)
            .fetch_one(pool)
            .await?;
    Ok(count)
}

pub async fn delete_with_assets(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("UPDATE projects SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_trash(pool: &SqlitePool) -> Result<Vec<Project>> {
    sqlx::query_as::<_, Project>(
        "SELECT * FROM projects WHERE is_deleted = 1 ORDER BY deleted_at DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn restore(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("UPDATE projects SET is_deleted = 0, deleted_at = NULL WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 永久清除单个回收站相册：先删掉只属于本相册的 assets 行（孤儿清理），
/// 再删 project。物理文件不动，与 [`purge_all`] 行为一致。
/// 仍属于其他相册的 asset 会保留。
pub async fn purge(pool: &SqlitePool, id: i64) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        DELETE FROM assets
        WHERE id IN (
            SELECT aa.asset_id FROM project_assets aa
            WHERE aa.project_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM project_assets aa2
                WHERE aa2.asset_id = aa.asset_id AND aa2.project_id <> ?
              )
        )
        "#,
    )
    .bind(id)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM projects WHERE id = ? AND is_deleted = 1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// 永久清空回收站：删掉所有「只属于回收站相册」的 assets 行，再批量删 projects。
/// 在多相册场景下，仍被未删除相册引用的 asset 会保留。
pub async fn purge_all(pool: &SqlitePool) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        DELETE FROM assets
        WHERE id IN (
            SELECT aa.asset_id FROM project_assets aa
            JOIN projects a ON a.id = aa.project_id
            WHERE a.is_deleted = 1
              AND NOT EXISTS (
                SELECT 1 FROM project_assets aa2
                JOIN projects a2 ON a2.id = aa2.project_id
                WHERE aa2.asset_id = aa.asset_id AND a2.is_deleted = 0
              )
        )
        "#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM projects WHERE is_deleted = 1")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

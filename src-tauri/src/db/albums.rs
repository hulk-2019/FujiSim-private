use crate::error::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

/// 虚拟相册的读模型。
///
/// 相册与资产是多对多（通过 `album_assets` 关联表），删除相册时关联表行因
/// `ON DELETE CASCADE` 自动清理，但**不**会删除 `assets` 表里的资产记录。
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Album {
    pub id: i64,
    pub name: String,
    pub created_at: String,
}

/// 创建相册。`name` 字段 UNIQUE，重名会返回 SQL 错误。
pub async fn create(pool: &SqlitePool, name: &str) -> Result<Album> {
    let id = sqlx::query("INSERT INTO albums (name) VALUES (?)")
        .bind(name)
        .execute(pool)
        .await?
        .last_insert_rowid();
    sqlx::query_as::<_, Album>("SELECT * FROM albums WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Album>> {
    sqlx::query_as::<_, Album>("SELECT * FROM albums ORDER BY name")
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM albums WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 批量把资产加入相册。使用事务保证全部成功或全部失败，
/// `ON CONFLICT DO NOTHING` 让重复关联是幂等的。
pub async fn add_assets(pool: &SqlitePool, album_id: i64, asset_ids: &[i64]) -> Result<()> {
    let mut tx = pool.begin().await?;
    for aid in asset_ids {
        sqlx::query(
            "INSERT INTO album_assets (album_id, asset_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(album_id)
        .bind(aid)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 批量从相册中移除资产关联（不删除资产本身）。
pub async fn remove_assets(pool: &SqlitePool, album_id: i64, asset_ids: &[i64]) -> Result<()> {
    let mut tx = pool.begin().await?;
    for aid in asset_ids {
        sqlx::query("DELETE FROM album_assets WHERE album_id = ? AND asset_id = ?")
            .bind(album_id)
            .bind(aid)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 检查名称是否已存在。`exclude_id` 用于重命名时排除自身。
pub async fn name_exists(
    pool: &SqlitePool,
    name: &str,
    exclude_id: Option<i64>,
) -> Result<bool> {
    let count: (i64,) = match exclude_id {
        Some(eid) => sqlx::query_as(
            "SELECT COUNT(*) FROM albums WHERE name = ? AND id != ?",
        )
        .bind(name)
        .bind(eid)
        .fetch_one(pool)
        .await?,
        None => sqlx::query_as("SELECT COUNT(*) FROM albums WHERE name = ?")
            .bind(name)
            .fetch_one(pool)
            .await?,
    };
    Ok(count.0 > 0)
}

pub async fn rename(pool: &SqlitePool, id: i64, name: &str) -> Result<Album> {
    let result = sqlx::query("UPDATE albums SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound.into());
    }
    sqlx::query_as::<_, Album>("SELECT * FROM albums WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// 查询文件夹内资产数量（用于删除确认弹框）。
pub async fn asset_count(pool: &SqlitePool, id: i64) -> Result<i64> {
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM album_assets WHERE album_id = ?")
            .bind(id)
            .fetch_one(pool)
            .await?;
    Ok(count)
}

/// 事务内物理删除文件夹：删除所有关联资产文件 → 删除资产记录 → 删除文件夹行。
/// 任一步失败则回滚。
pub async fn delete_with_assets(
    pool: &SqlitePool,
    id: i64,
) -> Result<Vec<String>> {
    let mut tx = pool.begin().await?;

    let paths: Vec<(String,)> = sqlx::query_as(
        "SELECT a.file_path FROM assets a \
         INNER JOIN album_assets aa ON aa.asset_id = a.id \
         WHERE aa.album_id = ?",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;

    sqlx::query(
        "DELETE FROM assets WHERE id IN \
         (SELECT asset_id FROM album_assets WHERE album_id = ?)",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM albums WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(paths.into_iter().map(|(p,)| p).collect())
}

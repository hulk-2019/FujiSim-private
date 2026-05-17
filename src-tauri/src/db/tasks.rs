use crate::error::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct BatchTask {
    pub id: i64,
    /// 任务状态：pending | processing | cancelled | done | error
    pub status: String,
    pub asset_id: i64,
    pub total: i64,
    pub export_settings_json: String,
    pub filter_settings_json: String,
    pub watermark_json: Option<String>,
    pub watermark_layer_path: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub is_deleted: i64,
    pub deleted_at: Option<String>,
    /// 成功数，由 asset_generations 聚合
    pub completed: i64,
    /// 失败数，由 asset_generations 聚合
    pub failed: i64,
}

const SELECT_WITH_COUNTS: &str = r#"
    SELECT
        bt.id, bt.status, bt.asset_id, bt.total,
        bt.export_settings_json, bt.filter_settings_json,
        bt.watermark_json, bt.watermark_layer_path,
        bt.created_at, bt.completed_at,
        bt.is_deleted, bt.deleted_at,
        COALESCE(SUM(CASE WHEN ag.status = 'Success' THEN 1 ELSE 0 END), 0) AS completed,
        COALESCE(SUM(CASE WHEN ag.status = 'Error'   THEN 1 ELSE 0 END), 0) AS failed
    FROM batch_tasks bt
    LEFT JOIN asset_generations ag ON ag.task_id = bt.id
"#;

/// 创建单条任务，初始状态为 `pending`。
pub async fn create(
    pool: &SqlitePool,
    asset_id: i64,
    export_settings_json: &str,
    filter_settings_json: &str,
    watermark_json: Option<&str>,
    watermark_layer_path: Option<&str>,
) -> Result<i64> {
    let id = sqlx::query(
        r#"INSERT INTO batch_tasks
           (status, asset_id, total, export_settings_json, filter_settings_json, watermark_json, watermark_layer_path)
           VALUES ('pending', ?, 1, ?, ?, ?, ?)"#,
    )
    .bind(asset_id)
    .bind(export_settings_json)
    .bind(filter_settings_json)
    .bind(watermark_json)
    .bind(watermark_layer_path)
    .execute(pool)
    .await?
    .last_insert_rowid();
    Ok(id)
}

/// 在事务中原子地取出最旧的 pending 任务并将其标记为 processing。
pub async fn claim_next_pending(pool: &SqlitePool) -> Result<Option<BatchTask>> {
    let mut tx = pool.begin().await?;

    let sql = format!(
        "{SELECT_WITH_COUNTS} WHERE bt.status = 'pending' AND bt.is_deleted = 0
         GROUP BY bt.id ORDER BY bt.id ASC LIMIT 1"
    );
    let task = sqlx::query_as::<_, BatchTask>(&sql)
        .fetch_optional(&mut *tx)
        .await?;

    if let Some(ref t) = task {
        sqlx::query("UPDATE batch_tasks SET status = 'processing' WHERE id = ?")
            .bind(t.id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(task)
}

pub async fn record_generation(
    pool: &SqlitePool,
    task_id: i64,
    asset_id: i64,
    output_path: Option<&str>,
    status: &str,
    error: Option<&str>,
) -> Result<()> {
    sqlx::query(
        r#"INSERT INTO asset_generations (task_id, asset_id, output_path, status, error_message)
           VALUES (?, ?, ?, ?, ?)"#,
    )
    .bind(task_id)
    .bind(asset_id)
    .bind(output_path)
    .bind(status)
    .bind(error)
    .execute(pool)
    .await?;
    Ok(())
}

/// 标记任务完成：全部失败则设 `error`，否则 `done`。
pub async fn finish(pool: &SqlitePool, task_id: i64) -> Result<()> {
    sqlx::query(
        r#"UPDATE batch_tasks
           SET status = (
               SELECT CASE
                   WHEN COUNT(CASE WHEN ag.status = 'Success' THEN 1 END) = 0
                        AND COUNT(CASE WHEN ag.status = 'Error' THEN 1 END) > 0
                   THEN 'error'
                   ELSE 'done'
               END
               FROM asset_generations ag WHERE ag.task_id = batch_tasks.id
           ),
           completed_at = datetime('now')
           WHERE id = ?"#,
    )
    .bind(task_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// 启动时加载需要展示/恢复的任务：pending、processing、cancelled、error。
pub async fn list_active_on_startup(pool: &SqlitePool) -> Result<Vec<BatchTask>> {
    let sql = format!(
        "{SELECT_WITH_COUNTS} WHERE bt.is_deleted = 0 AND bt.status IN ('pending', 'processing', 'cancelled', 'error') GROUP BY bt.id ORDER BY bt.id DESC"
    );
    sqlx::query_as::<_, BatchTask>(&sql)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

/// 仅标记取消状态，不软删除（UI 层仍可见，变为 cancelled 状态）。
pub async fn mark_cancelled(pool: &SqlitePool, task_id: i64) -> Result<()> {
    sqlx::query(
        "UPDATE batch_tasks SET status = 'cancelled', completed_at = COALESCE(completed_at, datetime('now')) WHERE id = ? AND is_deleted = 0",
    )
    .bind(task_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// 重置任务以便重试：清空旧的 asset_generations，状态改回 pending，撤销软删除。
pub async fn reset_for_retry(pool: &SqlitePool, task_id: i64) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM asset_generations WHERE task_id = ?")
        .bind(task_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE batch_tasks SET status = 'pending', completed_at = NULL, is_deleted = 0, deleted_at = NULL WHERE id = ?",
    )
    .bind(task_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn soft_delete(pool: &SqlitePool, task_id: i64) -> Result<()> {
    sqlx::query(
        "UPDATE batch_tasks SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?",
    )
    .bind(task_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// 批量取消 pending/processing 并软删除指定 id 列表。
pub async fn cancel_and_delete_batch(pool: &SqlitePool, ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let cancel_sql = format!(
        "UPDATE batch_tasks SET status = 'cancelled', completed_at = COALESCE(completed_at, datetime('now')) WHERE id IN ({placeholders}) AND status IN ('pending', 'processing')"
    );
    let delete_sql = format!(
        "UPDATE batch_tasks SET is_deleted = 1, deleted_at = datetime('now') WHERE id IN ({placeholders})"
    );
    let mut q = sqlx::query(&cancel_sql);
    for id in ids { q = q.bind(id); }
    q.execute(pool).await?;

    let mut q = sqlx::query(&delete_sql);
    for id in ids { q = q.bind(id); }
    q.execute(pool).await?;

    Ok(())
}

pub async fn clear_all(pool: &SqlitePool) -> Result<()> {
    for table in &[
        "asset_generations",
        "batch_tasks",
        "album_assets",
        "albums",
        "user_luts",
        "watermark_presets",
        "assets",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<Option<BatchTask>> {
    let sql = format!("{SELECT_WITH_COUNTS} WHERE bt.id = ? AND bt.is_deleted = 0 GROUP BY bt.id");
    sqlx::query_as::<_, BatchTask>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

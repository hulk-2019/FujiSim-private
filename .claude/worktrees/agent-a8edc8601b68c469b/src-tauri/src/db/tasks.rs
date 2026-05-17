use crate::error::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

/// 批量导出任务的"读模型"。
///
/// 一次 UI 上的"导出 N 张"操作会创建一行 `batch_tasks` 记录；
/// 任务进行中 `status='Processing'`，`completed` / `failed` 实时自增。
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct BatchTask {
    pub id: i64,
    pub status: String,
    pub total: i64,
    pub completed: i64,
    pub failed: i64,
    pub export_settings_json: String,
    pub filter_settings_json: String,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// 单张资产的生成结果。每张照片在一个批次中对应一行。
/// 用于后期"哪些失败了/失败原因是什么/产物路径是什么"的查询。
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AssetGeneration {
    pub id: i64,
    pub task_id: i64,
    pub asset_id: i64,
    pub output_path: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
}

/// 创建任务记录，把序列化后的滤镜与导出设置一并存档，方便日后审计/重跑。
pub async fn create(
    pool: &SqlitePool,
    total: i64,
    export_settings_json: &str,
    filter_settings_json: &str,
) -> Result<i64> {
    let id = sqlx::query(
        r#"INSERT INTO batch_tasks (status,total,completed,failed,export_settings_json,filter_settings_json)
           VALUES ('Processing', ?, 0, 0, ?, ?)"#,
    )
    .bind(total)
    .bind(export_settings_json)
    .bind(filter_settings_json)
    .execute(pool)
    .await?
    .last_insert_rowid();
    Ok(id)
}

/// 把一张资产的生成结果落库（成功或失败均调用，根据 `status` 区分）。
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

/// 进度自增。`ok=true` 自增 completed，否则自增 failed。
/// 用 SQL 自身的算术更新避免在多线程导出时读-改-写竞争。
pub async fn bump_progress(pool: &SqlitePool, task_id: i64, ok: bool) -> Result<()> {
    if ok {
        sqlx::query("UPDATE batch_tasks SET completed = completed + 1 WHERE id = ?")
            .bind(task_id)
            .execute(pool)
            .await?;
    } else {
        sqlx::query("UPDATE batch_tasks SET failed = failed + 1 WHERE id = ?")
            .bind(task_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// 标记任务完成。注意：当前实现把任何"跑完"都设为 'Completed'，
/// 即使有失败资产也是如此——失败明细在 `asset_generations` 表里。
pub async fn finish(pool: &SqlitePool, task_id: i64) -> Result<()> {
    sqlx::query(
        "UPDATE batch_tasks SET status = 'Completed', completed_at = datetime('now') WHERE id = ?",
    )
    .bind(task_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_recent(pool: &SqlitePool, limit: i64) -> Result<Vec<BatchTask>> {
    sqlx::query_as::<_, BatchTask>("SELECT * FROM batch_tasks ORDER BY id DESC LIMIT ?")
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<Option<BatchTask>> {
    sqlx::query_as::<_, BatchTask>("SELECT * FROM batch_tasks WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

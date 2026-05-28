use crate::error::Result;
use sqlx::{FromRow, SqlitePool};

const KIND_COVER: &str = "cover";
const LOCK_TIMEOUT_SECONDS: i64 = 300;

fn project_key(project_id: Option<i64>) -> i64 {
    project_id.unwrap_or(0)
}

fn project_id_from_key(project_id: i64) -> Option<i64> {
    if project_id == 0 {
        None
    } else {
        Some(project_id)
    }
}

#[derive(Debug, Clone, FromRow)]
pub struct CoverJob {
    pub asset_id: i64,
    pub project_id: i64,
}

impl CoverJob {
    pub fn project_id(&self) -> Option<i64> {
        project_id_from_key(self.project_id)
    }
}

pub async fn upsert_cover_jobs(
    pool: &SqlitePool,
    asset_ids: &[i64],
    project_id: Option<i64>,
    priority: i64,
) -> Result<()> {
    let project_id = project_key(project_id);
    for asset_id in asset_ids {
        sqlx::query(
            r#"
            INSERT INTO asset_derivatives (asset_id, project_id, kind, status, priority)
            VALUES (?, ?, ?, 'queued', ?)
            ON CONFLICT(asset_id, project_id, kind) DO UPDATE SET
                priority = MAX(asset_derivatives.priority, excluded.priority),
                status = CASE
                    WHEN asset_derivatives.status = 'failed' THEN 'queued'
                    ELSE asset_derivatives.status
                END,
                locked_by = CASE
                    WHEN asset_derivatives.status = 'failed' THEN NULL
                    ELSE asset_derivatives.locked_by
                END,
                locked_at = CASE
                    WHEN asset_derivatives.status = 'failed' THEN NULL
                    ELSE asset_derivatives.locked_at
                END,
                updated_at = datetime('now')
            "#,
        )
        .bind(asset_id)
        .bind(project_id)
        .bind(KIND_COVER)
        .bind(priority)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn claim_next_cover_job(pool: &SqlitePool, worker_id: &str) -> Result<Option<CoverJob>> {
    let job = sqlx::query_as::<_, CoverJob>(
        r#"
        UPDATE asset_derivatives
        SET
            status = 'running',
            attempts = attempts + 1,
            last_error = NULL,
            locked_by = ?,
            locked_at = CAST(strftime('%s', 'now') AS INTEGER),
            updated_at = datetime('now')
        WHERE id = (
            SELECT id
            FROM asset_derivatives
            WHERE kind = ?
              AND (
                status = 'queued'
                OR (
                  status = 'running'
                  AND locked_at IS NOT NULL
                  AND locked_at < CAST(strftime('%s', 'now') AS INTEGER) - ?
                )
              )
            ORDER BY priority DESC, attempts ASC, created_at ASC
            LIMIT 1
        )
        RETURNING asset_id, project_id
        "#,
    )
    .bind(worker_id)
    .bind(KIND_COVER)
    .bind(LOCK_TIMEOUT_SECONDS)
    .fetch_optional(pool)
    .await?;
    Ok(job)
}

pub async fn has_queued_cover_jobs(pool: &SqlitePool) -> Result<bool> {
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM asset_derivatives
        WHERE kind = ?
          AND (
            status = 'queued'
            OR (
              status = 'running'
              AND locked_at IS NOT NULL
              AND locked_at < CAST(strftime('%s', 'now') AS INTEGER) - ?
            )
          )
        "#,
    )
    .bind(KIND_COVER)
    .bind(LOCK_TIMEOUT_SECONDS)
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}

pub async fn reset_running_cover_jobs(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "UPDATE asset_derivatives SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = datetime('now') WHERE kind = ? AND status = 'running'",
    )
    .bind(KIND_COVER)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn reset_recoverable_cover_jobs(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE asset_derivatives
        SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = datetime('now')
        WHERE kind = ?
          AND status = 'failed'
          AND last_error LIKE 'cover thumbnail:%'
        "#,
    )
    .bind(KIND_COVER)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_cover_done(
    pool: &SqlitePool,
    asset_id: i64,
    project_id: Option<i64>,
    path: &str,
) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE asset_derivatives
        SET status = 'done', path = ?, last_error = NULL, locked_by = NULL, locked_at = NULL, updated_at = datetime('now')
        WHERE asset_id = ? AND project_id = ? AND kind = ?
        "#,
    )
    .bind(path)
    .bind(asset_id)
    .bind(project_key(project_id))
    .bind(KIND_COVER)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_cover_failed(
    pool: &SqlitePool,
    asset_id: i64,
    project_id: Option<i64>,
    error: &str,
) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE asset_derivatives
        SET status = 'failed', last_error = ?, locked_by = NULL, locked_at = NULL, updated_at = datetime('now')
        WHERE asset_id = ? AND project_id = ? AND kind = ?
        "#,
    )
    .bind(error)
    .bind(asset_id)
    .bind(project_key(project_id))
    .bind(KIND_COVER)
    .execute(pool)
    .await?;
    Ok(())
}

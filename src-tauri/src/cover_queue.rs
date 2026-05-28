use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::state::SharedState;

const MAX_COVER_CONCURRENCY: usize = 4;
const FAILURE_COOLDOWN: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct CoverJobKey {
    project_id: Option<i64>,
    asset_id: i64,
}

pub struct CoverQueue {
    inflight: Mutex<HashSet<CoverJobKey>>,
    failed_until: Mutex<HashMap<CoverJobKey, Instant>>,
    concurrency: AtomicUsize,
    running: AtomicUsize,
    worker_running: AtomicBool,
    worker_id: String,
}

impl CoverQueue {
    pub fn new(concurrency: usize) -> Self {
        let n = concurrency.clamp(1, MAX_COVER_CONCURRENCY);
        Self {
            inflight: Mutex::new(HashSet::new()),
            failed_until: Mutex::new(HashMap::new()),
            concurrency: AtomicUsize::new(n),
            running: AtomicUsize::new(0),
            worker_running: AtomicBool::new(false),
            worker_id: format!("cover-worker-{}", std::process::id()),
        }
    }

    pub fn set_concurrency(&self, n: usize) {
        self.concurrency
            .store(n.clamp(1, MAX_COVER_CONCURRENCY), Ordering::Relaxed);
    }

    pub fn concurrency(&self) -> usize {
        self.concurrency.load(Ordering::Relaxed)
    }

    /// Fire-and-forget: filters already-inflight ids, enqueues the rest,
    /// and spawns a background task to process them concurrently.
    pub fn enqueue(
        self: &Arc<Self>,
        asset_ids: Vec<i64>,
        project_id: Option<i64>,
        state: SharedState,
        app: tauri::AppHandle,
    ) {
        self.enqueue_with_priority(asset_ids, project_id, 10, state, app);
    }

    pub fn enqueue_with_priority(
        self: &Arc<Self>,
        asset_ids: Vec<i64>,
        project_id: Option<i64>,
        priority: i64,
        state: SharedState,
        app: tauri::AppHandle,
    ) {
        let enqueue_ids: Vec<i64> = {
            if let Ok(mut failed_until) = self.failed_until.lock() {
                let now = Instant::now();
                failed_until.retain(|_, until| *until > now);
            }
            asset_ids
                .into_iter()
                .filter_map(|asset_id| {
                    let key = CoverJobKey { project_id, asset_id };
                    let cooling_down = self
                        .failed_until
                        .lock()
                        .map(|failed_until| {
                            failed_until
                                .get(&key)
                                .is_some_and(|until| *until > Instant::now())
                        })
                        .unwrap_or(false);
                    if cooling_down {
                        return None;
                    }
                    Some(asset_id)
                })
                .collect()
        };
        if enqueue_ids.is_empty() {
            return;
        }

        let queue = self.clone();
        tokio::task::spawn(async move {
            let _ = crate::db::asset_derivatives::upsert_cover_jobs(
                &state.pool,
                &enqueue_ids,
                project_id,
                priority,
            )
            .await;
            queue.start_worker(state, app);
        });
    }

    fn start_worker(self: &Arc<Self>, state: SharedState, app: tauri::AppHandle) {
        if self
            .worker_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        let queue = self.clone();
        tokio::task::spawn(async move {
            let mut set = tokio::task::JoinSet::new();

            loop {
                if !state.low_priority_work_can_start() {
                    if set.is_empty() {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        continue;
                    }
                    let _ = set.join_next().await;
                    continue;
                }

                let mut claimed_any = false;
                while queue.running.load(Ordering::Acquire) < queue.concurrency() {
                    let job = match crate::db::asset_derivatives::claim_next_cover_job(
                        &state.pool,
                        &queue.worker_id,
                    )
                    .await
                    {
                        Ok(Some(job)) => job,
                        Ok(None) => break,
                        Err(e) => {
                            tracing::warn!(error = %e, "cover_queue: claim next job failed");
                            break;
                        }
                    };
                    claimed_any = true;
                    let key = CoverJobKey {
                        project_id: job.project_id(),
                        asset_id: job.asset_id,
                    };
                    let _ = queue.mark_inflight(key);
                    let cover_slot = queue.acquire_slot().await;
                    let background_permit = state.background_limiter.acquire_cover_fast().await;
                    let Some(background_permit) = background_permit else {
                        break;
                    };
                    let state = state.clone();
                    let app = app.clone();
                    let queue = queue.clone();

                    set.spawn_blocking(move || {
                        let _cover_slot = cover_slot;
                        let _background_permit = background_permit;
                        struct Guard {
                            queue: Arc<CoverQueue>,
                            key: CoverJobKey,
                        }
                        impl Drop for Guard {
                            fn drop(&mut self) {
                                if let Ok(mut inflight) = self.queue.inflight.lock() {
                                    inflight.remove(&self.key);
                                }
                            }
                        }
                        let _guard = Guard {
                            queue: queue.clone(),
                            key,
                        };
                        if let Err(e) = process_one(key.asset_id, key.project_id, &state, &app) {
                            let rt = tokio::runtime::Handle::current();
                            let _ = rt.block_on(crate::db::asset_derivatives::mark_cover_failed(
                                &state.pool,
                                key.asset_id,
                                key.project_id,
                                &e,
                            ));
                            queue.mark_failed(key);
                        }
                    });
                }

                if set.is_empty() && !claimed_any {
                    break;
                }

                let _ = set.join_next().await;
            }
            while set.join_next().await.is_some() {}
            queue.worker_running.store(false, Ordering::Release);
            if matches!(
                crate::db::asset_derivatives::has_queued_cover_jobs(&state.pool).await,
                Ok(true)
            ) {
                queue.start_worker(state.clone(), app.clone());
            }
            let _ = app.emit("thumbnail:all_done", ());
        });
    }

    fn mark_inflight(&self, key: CoverJobKey) -> bool {
        self.inflight
            .lock()
            .map(|mut inflight| inflight.insert(key))
            .unwrap_or(false)
    }

    async fn acquire_slot(self: &Arc<Self>) -> CoverSlot {
        loop {
            let running = self.running.load(Ordering::Acquire);
            let limit = self.concurrency();
            if running < limit
                && self
                    .running
                    .compare_exchange(running, running + 1, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
            {
                return CoverSlot { queue: self.clone() };
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn mark_failed(&self, key: CoverJobKey) {
        if let Ok(mut failed_until) = self.failed_until.lock() {
            failed_until.insert(key, Instant::now() + FAILURE_COOLDOWN);
        }
    }
}

struct CoverSlot {
    queue: Arc<CoverQueue>,
}

impl Drop for CoverSlot {
    fn drop(&mut self) {
        self.queue.running.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Must only be called from a `spawn_blocking` context — calls `block_on` internally.
fn process_one(
    asset_id: i64,
    project_id: Option<i64>,
    state: &SharedState,
    app: &tauri::AppHandle,
) -> std::result::Result<(), String> {
    let rt = tokio::runtime::Handle::current();

    let asset = match rt.block_on(crate::db::assets::get(&state.pool, asset_id)) {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!(asset_id, error = %e, "cover_queue: asset not found");
            return Err(e.to_string());
        }
    };

    let file_path = PathBuf::from(&asset.file_path);
    let cover_dir = crate::processing::raw::cache_scope_dir(&state.cover_dir, project_id);
    let cover_path = cover_dir.join(format!("{asset_id}.jpg"));

    if cover_path.exists() {
        let cover_path_str = cover_path.to_string_lossy().to_string();
        let _ = rt.block_on(crate::db::assets::update_cover_path(
            &state.pool,
            asset_id,
            &cover_path_str,
        ));
        let _ = rt.block_on(crate::db::asset_derivatives::mark_cover_done(
            &state.pool,
            asset_id,
            project_id,
            &cover_path_str,
        ));
        let _ = app.emit(
            "thumbnail:done",
            &crate::ipc::ThumbnailDonePayload { asset_id },
        );
        return Ok(());
    }

    let cover_jpeg = match crate::processing::raw::extract_cover_fast(&file_path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(asset_id, error = %e, "cover_queue: extract failed");
            return Err(e.to_string());
        }
    };

    if let Err(e) = std::fs::create_dir_all(&cover_dir)
        .and_then(|_| std::fs::write(&cover_path, &cover_jpeg))
    {
        tracing::warn!(asset_id, error = %e, "cover_queue: write failed");
        return Err(e.to_string());
    }

    let cover_path_str = cover_path.to_string_lossy().to_string();
    let _ = rt.block_on(crate::db::assets::update_cover_path(
        &state.pool,
        asset_id,
        &cover_path_str,
    ));
    let _ = rt.block_on(crate::db::asset_derivatives::mark_cover_done(
        &state.pool,
        asset_id,
        project_id,
        &cover_path_str,
    ));
    let _ = app.emit(
        "thumbnail:done",
        &crate::ipc::ThumbnailDonePayload { asset_id },
    );
    Ok(())
}

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::sync::Semaphore;

use crate::state::SharedState;

pub struct CoverQueue {
    inflight: Mutex<HashSet<i64>>,
    concurrency: AtomicUsize,
}

impl CoverQueue {
    pub fn new(concurrency: usize) -> Self {
        Self {
            inflight: Mutex::new(HashSet::new()),
            concurrency: AtomicUsize::new(concurrency.clamp(2, 4)),
        }
    }

    pub fn set_concurrency(&self, n: usize) {
        self.concurrency.store(n.clamp(2, 4), Ordering::Relaxed);
    }

    pub fn concurrency(&self) -> usize {
        self.concurrency.load(Ordering::Relaxed)
    }

    /// Fire-and-forget: filters already-inflight ids, enqueues the rest,
    /// and spawns a background task to process them concurrently.
    pub fn enqueue(self: &Arc<Self>, asset_ids: Vec<i64>, state: SharedState, app: tauri::AppHandle) {
        let new_ids: Vec<i64> = {
            let mut inflight = self.inflight.lock().expect("cover_queue inflight poisoned");
            asset_ids.into_iter().filter(|id| inflight.insert(*id)).collect()
        };
        if new_ids.is_empty() {
            return;
        }

        let queue = self.clone();
        tokio::task::spawn(async move {
            let concurrency = queue.concurrency();
            let sem = Arc::new(Semaphore::new(concurrency));
            let mut set = tokio::task::JoinSet::new();

            for asset_id in new_ids {
                let permit = sem.clone().acquire_owned().await;
                let Ok(permit) = permit else { break };
                let state = state.clone();
                let app = app.clone();
                let queue = queue.clone();

                set.spawn_blocking(move || {
                    let _permit = permit;
                    struct Guard {
                        queue: Arc<CoverQueue>,
                        asset_id: i64,
                    }
                    impl Drop for Guard {
                        fn drop(&mut self) {
                            if let Ok(mut inflight) = self.queue.inflight.lock() {
                                inflight.remove(&self.asset_id);
                            }
                        }
                    }
                    let _guard = Guard { queue: queue.clone(), asset_id };
                    process_one(asset_id, &state, &app);
                });
            }

            while set.join_next().await.is_some() {}
            let _ = app.emit("thumbnail:all_done", ());
        });
    }
}

/// Must only be called from a `spawn_blocking` context — calls `block_on` internally.
fn process_one(asset_id: i64, state: &SharedState, app: &tauri::AppHandle) {
    let rt = tokio::runtime::Handle::current();

    let asset = match rt.block_on(crate::db::assets::get(&state.pool, asset_id)) {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!(asset_id, error = %e, "cover_queue: asset not found");
            return;
        }
    };

    let file_path = PathBuf::from(&asset.file_path);
    let mtime = file_path.metadata().ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cover_path = state.cover_dir.join(format!("{}_{}.jpg", asset_id, mtime));

    if cover_path.exists() {
        let _ = app.emit("thumbnail:done", &crate::ipc::ThumbnailDonePayload { asset_id });
        return;
    }

    let cover_jpeg = match crate::processing::raw::extract_cover_fast(&file_path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(asset_id, error = %e, "cover_queue: extract failed");
            return;
        }
    };

    if let Err(e) = std::fs::create_dir_all(&state.cover_dir)
        .and_then(|_| std::fs::write(&cover_path, &cover_jpeg))
    {
        tracing::warn!(asset_id, error = %e, "cover_queue: write failed");
        return;
    }

    let cover_path_str = cover_path.to_string_lossy().to_string();
    let _ = rt.block_on(crate::db::assets::update_cover_path(&state.pool, asset_id, &cover_path_str));
    let _ = app.emit("thumbnail:done", &crate::ipc::ThumbnailDonePayload { asset_id });
}

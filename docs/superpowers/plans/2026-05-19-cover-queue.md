# Cover Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `spawn_cover_worker` + hardcoded `cover_sem` with a global `CoverQueue` that deduplicates by `asset_id`, supports configurable concurrency (min 2), and is the single entry point for all RAW/DNG cover generation.

**Architecture:** A new `CoverQueue` struct in `cover_queue.rs` holds an `inflight: Mutex<HashSet<i64>>` for dedup and a `concurrency: AtomicUsize` for runtime-adjustable parallelism. `enqueue()` is fire-and-forget: it filters already-inflight ids, adds new ones, then spawns a tokio task that drives a `JoinSet` bounded by a fresh `Semaphore(concurrency)`. Both `import_directory` and `import_files` call `cover_queue.enqueue()` instead of `spawn_cover_worker`. Dead IPC commands (`generate_thumbnails`, `list_raw_asset_ids`) are removed.

**Tech Stack:** Rust, Tokio (`JoinSet`, `Semaphore`, `spawn_blocking`), SQLite via sqlx, Tauri events, TypeScript frontend.

---

### Task 1: Create `cover_queue.rs`

**Files:**
- Create: `src-tauri/src/cover_queue.rs`

- [ ] **Step 1: Write the new file**

```rust
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
            concurrency: AtomicUsize::new(concurrency.max(2)),
        }
    }

    pub fn set_concurrency(&self, n: usize) {
        self.concurrency.store(n.max(2), Ordering::Relaxed);
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
                    process_one(asset_id, &state, &app);
                    queue.inflight.lock().expect("cover_queue inflight poisoned").remove(&asset_id);
                });
            }

            while set.join_next().await.is_some() {}
            let _ = app.emit("thumbnail:all_done", ());
        });
    }
}

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
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/cover_queue.rs
git commit -m "feat: add CoverQueue with dedup and configurable concurrency"
```

---

### Task 2: Wire `CoverQueue` into `AppState`

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `cover_queue` field and remove `cover_sem` in `state.rs`**

In `AppState` struct, replace:
```rust
/// 封面图生成专用信号量，容量 4，与 EXIF io_sem 解耦
pub cover_sem: Arc<Semaphore>,
```
with:
```rust
pub cover_queue: Arc<crate::cover_queue::CoverQueue>,
```

- [ ] **Step 2: Update `AppState::init()` in `state.rs`**

Replace the `cover_sem` initialization:
```rust
// 封面图生成专用信号量，容量 4，与 EXIF io_sem 解耦
cover_sem: Arc::new(Semaphore::new(4)),
```
with:
```rust
cover_queue: Arc::new(crate::cover_queue::CoverQueue::new(
    (logical_cpus / 2).max(2),
)),
```

Also remove the unused `Semaphore` import if it's only used for `cover_sem` (check: `io_sem` and `preview_sem` still use it, so the import stays).

- [ ] **Step 3: Add `pub mod cover_queue` in `lib.rs`**

After the existing `pub mod queue;` line, add:
```rust
pub mod cover_queue;
```

- [ ] **Step 4: Verify it compiles**

```bash
cd src-tauri && cargo check 2>&1 | head -40
```

Expected: errors only about `cover_sem` still referenced in `ipc.rs` (will fix in Task 3). No other errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "feat: wire CoverQueue into AppState, remove cover_sem"
```

---

### Task 3: Update `ipc.rs` — replace `spawn_cover_worker`, delete dead code

**Files:**
- Modify: `src-tauri/src/ipc.rs`

- [ ] **Step 1: Update `import_directory` to use `cover_queue`**

In `import_directory`, replace:
```rust
start_exif_worker(state.inner().clone(), app.clone());
spawn_cover_worker(state.inner().clone(), app, scan.items.iter()
    .filter(|a| a.is_raw)
    .map(|a| a.file_path.clone())
    .collect());
```
with:
```rust
start_exif_worker(state.inner().clone(), app.clone());
let raw_ids: Vec<i64> = {
    let paths: Vec<String> = scan.items.iter()
        .filter(|a| a.is_raw)
        .map(|a| a.file_path.clone())
        .collect();
    assets::ids_by_paths(&state.pool, &paths).await.unwrap_or_default()
};
state.cover_queue.enqueue(raw_ids, state.inner().clone(), app);
```

- [ ] **Step 2: Update `import_files` to use `cover_queue`**

In `import_files`, replace:
```rust
start_exif_worker(state.inner().clone(), app.clone());
spawn_cover_worker(state.inner().clone(), app, scan.items.iter()
    .filter(|a| a.is_raw)
    .map(|a| a.file_path.clone())
    .collect());
```
with:
```rust
start_exif_worker(state.inner().clone(), app.clone());
let raw_ids: Vec<i64> = {
    let paths: Vec<String> = scan.items.iter()
        .filter(|a| a.is_raw)
        .map(|a| a.file_path.clone())
        .collect();
    assets::ids_by_paths(&state.pool, &paths).await.unwrap_or_default()
};
state.cover_queue.enqueue(raw_ids, state.inner().clone(), app);
```

- [ ] **Step 3: Delete `spawn_cover_worker` function**

Remove the entire `fn spawn_cover_worker(...)` function (lines ~1364–1420 in current file).

- [ ] **Step 4: Delete `generate_thumbnails` IPC command**

Remove the entire `pub async fn generate_thumbnails(...)` function (lines ~1426–1450).

- [ ] **Step 5: Delete `list_raw_asset_ids` IPC command**

Remove the entire `pub async fn list_raw_asset_ids(...)` function (lines ~1041–1044).

- [ ] **Step 6: Add `set_cover_concurrency` IPC command**

Add after `get_cover_dir`:
```rust
#[tauri::command]
pub async fn set_cover_concurrency(state: State<'_, SharedState>, n: usize) -> Result<()> {
    state.cover_queue.set_concurrency(n);
    Ok(())
}
```

- [ ] **Step 7: Verify it compiles**

```bash
cd src-tauri && cargo check 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/ipc.rs
git commit -m "feat: replace spawn_cover_worker with cover_queue, remove dead IPC commands"
```

---

### Task 4: Update `lib.rs` invoke_handler

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Remove dead commands and add new one**

In the `invoke_handler!` macro, remove:
```rust
ipc::generate_thumbnails,
ipc::list_raw_asset_ids,
```

Add after `ipc::get_cover_dir`:
```rust
ipc::set_cover_concurrency,
```

- [ ] **Step 2: Verify it compiles**

```bash
cd src-tauri && cargo check 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "chore: update invoke_handler for cover queue commands"
```

---

### Task 5: Update frontend `api.ts`

**Files:**
- Modify: `src/api.ts`

- [ ] **Step 1: Remove dead methods and add `setCoverConcurrency`**

Remove these two methods from the `api` object:
```typescript
listRawAssetIds: () => invoke<number[]>("list_raw_asset_ids"),

generateThumbnails: (assetIds: number[]) =>
  invoke<void>("generate_thumbnails", { assetIds }),
```

Add after `getCoverDir`:
```typescript
setCoverConcurrency: (n: number) =>
  invoke<void>("set_cover_concurrency", { n }),
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/api.ts
git commit -m "chore: remove dead thumbnail API methods, add setCoverConcurrency"
```

---

### Task 6: Full build verification

- [ ] **Step 1: Run full Rust build**

```bash
cd src-tauri && cargo build 2>&1 | tail -20
```

Expected: `Finished` with no errors.

- [ ] **Step 2: Run Tauri dev to smoke-test import flow**

```bash
cd /Users/ry2019/private/FujiSim && cargo tauri dev 2>&1 &
```

Import a directory containing RAW/DNG files. Verify:
- Import completes without crash
- `thumbnail:done` events fire for each RAW asset
- Cover images appear in the asset grid
- Re-importing the same directory does not duplicate work (check logs for "cover_queue: asset not found" or duplicate `thumbnail:done` events — there should be none)

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: cover queue — dedup by asset_id, configurable concurrency"
```

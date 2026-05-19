# Cover Queue Design

**Date:** 2026-05-19  
**Status:** Approved

## Goal

Replace the ad-hoc `spawn_cover_worker` with a global `CoverQueue` that deduplicates tasks by `asset_id`, supports configurable concurrency (min 2), and is the single entry point for all cover generation. Import triggers enqueue; the frontend is passive (listens for `thumbnail:done` only).

## Current Behavior

```
import_directory / import_files
  └─ spawn_cover_worker(raw_paths)   ← detached tokio::spawn
       └─ cover_sem (Semaphore, hardcoded 4)
       └─ JoinSet + spawn_blocking per path
       └─ extract_cover_fast → write disk → update_cover_path DB
       └─ emit thumbnail:done per asset
       └─ emit thumbnail:all_done
```

Problems:
- No deduplication: re-importing the same directory spawns duplicate work
- Hardcoded concurrency (4)
- Dead IPC commands: `generate_thumbnails`, `list_raw_asset_ids`

## New Behavior

```
import_directory / import_files
  └─ insert_many (DB)
  └─ cover_queue.enqueue(raw_asset_ids)
       └─ filter out inflight ids (dedup)
       └─ add remaining to inflight
       └─ spawn_blocking per id (bounded by concurrency)
            └─ extract_cover_fast
            └─ write disk
            └─ update_cover_path DB
            └─ emit thumbnail:done
            └─ remove from inflight
  └─ emit import:done
  └─ return ImportReport
```

Frontend: no changes to `loadPage` or any trigger logic. Only listens for `thumbnail:done`.

## Backend Changes

### New file: `src-tauri/src/cover_queue.rs`

```rust
pub struct CoverQueue {
    inflight: Mutex<HashSet<i64>>,
    concurrency: AtomicUsize,
}

impl CoverQueue {
    pub fn new(concurrency: usize) -> Self { ... }
    pub fn set_concurrency(&self, n: usize) { ... }  // max(n, 2)
    pub fn enqueue(&self, asset_ids: Vec<i64>, state: SharedState, app: AppHandle) { ... }
}
```

`enqueue` is fire-and-forget: filters inflight, adds new ids to inflight, spawns a tokio task that runs up to `concurrency` blocking workers concurrently via `JoinSet` + `Semaphore` created inline.

Task id for dedup is the `asset_id` itself (i64). No separate task id needed.

### `src-tauri/src/state.rs`

- Add `cover_queue: Arc<CoverQueue>` to `AppState`
- Initialize with `max(logical_cpus / 2, 2)`
- Remove `cover_sem: Arc<Semaphore>`

### `src-tauri/src/ipc.rs`

| Change | Detail |
|--------|--------|
| `import_directory` | Replace `spawn_cover_worker(...)` with `state.cover_queue.enqueue(raw_ids, ...)` |
| `import_files` | Same |
| Delete `spawn_cover_worker` | Logic moved to `CoverQueue` |
| Delete `generate_thumbnails` | Dead code, no callers |
| Delete `list_raw_asset_ids` | Dead code, no callers |
| Add `set_cover_concurrency(n: usize)` | Delegates to `cover_queue.set_concurrency(n)` |

### `src-tauri/src/lib.rs`

- Register `set_cover_concurrency` in `invoke_handler`
- Remove `generate_thumbnails`, `list_raw_asset_ids`
- Add `pub mod cover_queue`

## Frontend Changes

### `src/api.ts`

- Delete `generateThumbnails`
- Delete `listRawAssetIds`
- Add `setCoverConcurrency(n: number)`

### No changes to

- `src/store.ts` — `loadPage` unchanged
- `src/App.tsx` — `thumbnail:done` listener unchanged
- `src/components/AssetGrid.tsx` — cover display logic unchanged

## Files Affected

| File | Change |
|------|--------|
| `src-tauri/src/cover_queue.rs` | New file |
| `src-tauri/src/state.rs` | Add `cover_queue`, remove `cover_sem` |
| `src-tauri/src/ipc.rs` | Replace `spawn_cover_worker`, delete dead commands, add `set_cover_concurrency` |
| `src-tauri/src/lib.rs` | Module + invoke_handler updates |
| `src/api.ts` | Delete dead methods, add `setCoverConcurrency` |

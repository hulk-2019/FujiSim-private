# Thumbnail Generation During Import

**Date:** 2026-05-19  
**Status:** Approved

## Goal

Generate RAW file thumbnails inline during the import process rather than as a detached background worker. The `import_directory` / `import_files` commands block until all cover images are written to disk and DB, so the asset list displays complete thumbnails immediately on import completion. A progress bar in the asset list area shows generation status while the user waits.

## Current Behavior

```
import_directory
  └─ scan_dir (blocking)
  └─ insert_many (DB)
  └─ emit import:done
  └─ tokio::spawn(spawn_cover_worker)  ← detached, returns immediately
  └─ return ImportReport

spawn_cover_worker (background, no progress)
  └─ JoinSet + Semaphore(4, hardcoded)
  └─ extract_cover_fast per RAW asset
  └─ update_cover_path in DB
  └─ emit thumbnail:done per asset
  └─ emit thumbnail:all_done
```

## New Behavior

```
import_directory
  └─ scan_dir (blocking)
  └─ insert_many (DB)
  └─ run_cover_generation (awaited inline)   ← blocks until done
       └─ JoinSet + Semaphore(dynamic)
       └─ extract_cover_fast per RAW asset
       └─ update_cover_path in DB
       └─ emit thumbnail:progress { completed, total } per asset
       └─ emit thumbnail:done per asset (preserved for compatibility)
  └─ emit import:done (all thumbnails ready at this point)
  └─ return ImportReport
```

## Backend Changes

### Dynamic Concurrency (`src-tauri/src/ipc.rs`)

Replace hardcoded `Semaphore::new(4)` with:

```rust
let concurrency = std::thread::available_parallelism()
    .map(|n| n.get())
    .unwrap_or(4)
    / 2;
let concurrency = concurrency.max(2);
let sem = Arc::new(Semaphore::new(concurrency));
```

Examples: 4-core → 2, 8-core → 4, 16-core → 8.

### New Progress Event

```rust
#[derive(Clone, Serialize)]
pub struct ThumbnailProgress {
    pub completed: i64,
    pub total: i64,
}
```

Emitted after each completed cover extraction:

```rust
app.emit("thumbnail:progress", ThumbnailProgress { completed, total });
```

### `run_cover_generation` function

Extract the cover generation logic from `spawn_cover_worker` into a standalone `async fn run_cover_generation(app, pool, cover_dir, items)` that can be directly awaited. The original `spawn_cover_worker` (used for on-demand regeneration flows if any) can delegate to this.

`import:done` is emitted **after** `run_cover_generation` completes.

The `thumbnail:all_done` event is emitted at the end of `run_cover_generation` (before `import:done`).

### Both `import_directory` and `import_files`

Apply the same change to both IPC commands.

## Frontend Changes

### Store (`src/store.ts`)

Add state:

```typescript
thumbnailProgress: { completed: number; total: number } | null;
setThumbnailProgress: (p: { completed: number; total: number } | null) => void;
```

Reset to `null` when `setImporting(false, ...)` is called (i.e., on `import:done`).

### Event Listeners (`src/App.tsx`)

```typescript
listen<{ completed: number; total: number }>("thumbnail:progress", (e) => {
  setThumbnailProgress(e.payload);
});
```

### Progress Bar (`src/components/AssetGrid.tsx`)

When `importing === true`:
- If `thumbnailProgress === null`: show existing importing spinner (scan phase)
- If `thumbnailProgress !== null`: replace spinner with shadcn `Progress` bar + label "正在生成缩略图… {completed}/{total}"

Progress bar is removed from the UI as soon as `importing` becomes `false`.

## Non-Goals

- On-demand thumbnail regeneration (separate command, unchanged)
- Cancellation of in-progress import
- Scan progress reporting (not requested)
- Changes to EXIF extraction worker (remains detached background)

## Files Affected

| File | Change |
|------|--------|
| `src-tauri/src/ipc.rs` | Extract `run_cover_generation`, await inline in `import_directory` + `import_files`, add `ThumbnailProgress` struct, dynamic concurrency |
| `src/store.ts` | Add `thumbnailProgress` state + setter |
| `src/App.tsx` | Add `thumbnail:progress` listener |
| `src/components/AssetGrid.tsx` | Conditional progress bar during import |

# Thumbnail Generation During Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `import_directory` / `import_files` block until all RAW cover images are generated, emitting `thumbnail:progress` events so the UI can show a progress bar while waiting.

**Architecture:** Extract cover-generation logic from `spawn_cover_worker` into an awaitable `async fn run_cover_generation`. Both import commands call it inline (`.await`) instead of detaching it. `import:done` fires only after all thumbnails are written. Frontend adds `thumbnailProgress` state and renders a progress bar in the asset list while `importing === true`.

**Tech Stack:** Rust/Tauri (`tokio`, `std::thread::available_parallelism`), TypeScript/React, Zustand, react-i18next

---

## File Map

| File | Change |
|------|--------|
| `src-tauri/src/ipc.rs` | Add `ThumbnailProgress` struct; add `run_cover_generation` async fn; update `import_directory`, `import_files`, and `spawn_cover_worker` |
| `src/store.ts` | Add `thumbnailProgress` + `setThumbnailProgress`; clear on `setImporting(false)` |
| `src/App.tsx` | Add `thumbnail:progress` event listener |
| `src/components/AssetGrid.tsx` | Conditional progress bar when `importing && thumbnailProgress != null` |
| `src/i18n/zh.ts` | Add `assetGrid.generatingThumbnails` key |
| `src/i18n/en.ts` | Add `assetGrid.generatingThumbnails` key |

---

## Task 1: Add `ThumbnailProgress` struct and `run_cover_generation` in `ipc.rs`

**Files:**
- Modify: `src-tauri/src/ipc.rs` (around line 1352, after `ThumbnailDonePayload`)

- [ ] **Step 1: Add `ThumbnailProgress` struct**

In `src-tauri/src/ipc.rs`, after the `ThumbnailDonePayload` struct (around line 1356), add:

```rust
/// `thumbnail:progress` 事件载荷：本次批量生成的整体进度。
#[derive(Debug, Serialize, Clone)]
pub struct ThumbnailProgress {
    pub completed: i64,
    pub total: i64,
}
```

- [ ] **Step 2: Add `run_cover_generation` async fn**

Directly after `ThumbnailProgress`, add the new function. This is the extracted core logic from `spawn_cover_worker`, made awaitable and with progress events added:

```rust
/// 批量生成 RAW 封面图的核心逻辑（可直接 await）。
///
/// 动态并发：`available_parallelism / 2`，最少 2。
/// 每完成一张后 emit `thumbnail:progress`；全部完成后 emit `thumbnail:all_done`。
async fn run_cover_generation(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    cover_dir: &std::path::PathBuf,
    raw_paths: Vec<String>,
) {
    if raw_paths.is_empty() {
        return;
    }
    let concurrency = std::thread::available_parallelism()
        .map(|n| n.get() / 2)
        .unwrap_or(2)
        .max(2);
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(concurrency));
    let total = raw_paths.len() as i64;
    let mut completed: i64 = 0;
    let mut set = tokio::task::JoinSet::new();

    for file_path in raw_paths {
        let permit = sem.clone().acquire_owned().await;
        let Ok(permit) = permit else { break };
        let cover_dir = cover_dir.clone();
        let pool = pool.clone();
        let app = app.clone();
        set.spawn_blocking(move || {
            let _permit = permit;
            let path = std::path::Path::new(&file_path);
            let mtime = path
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let rt = tokio::runtime::Handle::current();
            let asset_id =
                match rt.block_on(crate::db::assets::id_by_path(&pool, &file_path)) {
                    Ok(Some(id)) => id,
                    _ => return,
                };

            let cover_path = cover_dir.join(format!("{}_{}.jpg", asset_id, mtime));
            if cover_path.exists() {
                let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id });
                return;
            }

            let cover_jpeg = match crate::processing::raw::extract_cover_fast(path) {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(asset_id, error = %e, "cover worker: extract failed");
                    return;
                }
            };
            if let Err(e) = std::fs::create_dir_all(&cover_dir)
                .and_then(|_| std::fs::write(&cover_path, &cover_jpeg))
            {
                tracing::warn!(asset_id, error = %e, "cover worker: write failed");
                return;
            }
            let cover_path_str = cover_path.to_string_lossy().to_string();
            let _ = rt.block_on(crate::db::assets::update_cover_path(
                &pool,
                asset_id,
                &cover_path_str,
            ));
            let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id });
        });
    }

    while set.join_next().await.is_some() {
        completed += 1;
        let _ = app.emit(
            "thumbnail:progress",
            &ThumbnailProgress { completed, total },
        );
    }
    let _ = app.emit("thumbnail:all_done", ());
}
```

- [ ] **Step 3: Update `spawn_cover_worker` to delegate to `run_cover_generation`**

Replace the entire body of `spawn_cover_worker` (lines 1364–1420) with a thin wrapper:

```rust
fn spawn_cover_worker(state: SharedState, app: tauri::AppHandle, raw_paths: Vec<String>) {
    if raw_paths.is_empty() {
        return;
    }
    tokio::task::spawn(async move {
        run_cover_generation(&app, &state.pool, &state.cover_dir, raw_paths).await;
    });
}
```

- [ ] **Step 4: Build to verify no compile errors**

```bash
cd src-tauri && cargo build 2>&1 | tail -20
```

Expected: `Finished` with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ipc.rs
git commit -m "refactor(ipc): extract run_cover_generation as awaitable fn"
```

---

## Task 2: Update `import_directory` and `import_files` to await cover generation

**Files:**
- Modify: `src-tauri/src/ipc.rs` lines 68–100 and 776–810

- [ ] **Step 1: Update `import_directory`**

Replace lines 88–99 in `import_directory` (the section after album insert, through the worker spawns):

**Before:**
```rust
    let report = ImportReport {
        inserted,
        scanned,
        skipped: scan.skipped,
    };
    let _ = app.emit("import:done", &report);
    start_exif_worker(state.inner().clone(), app.clone());
    spawn_cover_worker(state.inner().clone(), app, scan.items.iter()
        .filter(|a| a.is_raw)
        .map(|a| a.file_path.clone())
        .collect());
    Ok(report)
```

**After:**
```rust
    let report = ImportReport {
        inserted,
        scanned,
        skipped: scan.skipped,
    };
    start_exif_worker(state.inner().clone(), app.clone());
    let raw_paths: Vec<String> = scan.items.iter()
        .filter(|a| a.is_raw)
        .map(|a| a.file_path.clone())
        .collect();
    run_cover_generation(&app, &state.pool, &state.cover_dir, raw_paths).await;
    let _ = app.emit("import:done", &report);
    Ok(report)
```

- [ ] **Step 2: Update `import_files`**

Replace lines 798–809 in `import_files` (same pattern):

**Before:**
```rust
    let report = ImportReport {
        inserted,
        scanned,
        skipped: scan.skipped,
    };
    let _ = app.emit("import:done", &report);
    start_exif_worker(state.inner().clone(), app.clone());
    spawn_cover_worker(state.inner().clone(), app, scan.items.iter()
        .filter(|a| a.is_raw)
        .map(|a| a.file_path.clone())
        .collect());
    Ok(report)
```

**After:**
```rust
    let report = ImportReport {
        inserted,
        scanned,
        skipped: scan.skipped,
    };
    start_exif_worker(state.inner().clone(), app.clone());
    let raw_paths: Vec<String> = scan.items.iter()
        .filter(|a| a.is_raw)
        .map(|a| a.file_path.clone())
        .collect();
    run_cover_generation(&app, &state.pool, &state.cover_dir, raw_paths).await;
    let _ = app.emit("import:done", &report);
    Ok(report)
```

- [ ] **Step 3: Build to verify**

```bash
cd src-tauri && cargo build 2>&1 | tail -20
```

Expected: `Finished` with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ipc.rs
git commit -m "feat(import): await cover generation inline before import:done"
```

---

## Task 3: Add `thumbnailProgress` state to Zustand store

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: Add state type to the interface**

In `src/store.ts`, in the `// ===== RAW 缩略图缓存 =====` section (around line 123), add after `clearThumbnailReady`:

```typescript
  /** 导入过程中缩略图生成进度；null 表示不在生成中 */
  thumbnailProgress: { completed: number; total: number } | null;
  setThumbnailProgress: (p: { completed: number; total: number } | null) => void;
```

- [ ] **Step 2: Add initial state value**

In the `create(...)` initial state object (around line 222 where `importing: false` is defined), add:

```typescript
  thumbnailProgress: null,
```

- [ ] **Step 3: Add the setter implementation**

Near the other setters (around line 412 where `setImporting` is defined), add:

```typescript
  setThumbnailProgress: (p) => set({ thumbnailProgress: p }),
```

- [ ] **Step 4: Reset `thumbnailProgress` when import ends**

Find `setImporting` implementation (around line 412):

```typescript
  setImporting: (flag, last) =>
    set({ importing: flag, lastImport: last ?? get().lastImport }),
```

Replace with:

```typescript
  setImporting: (flag, last) =>
    set({
      importing: flag,
      lastImport: last ?? get().lastImport,
      thumbnailProgress: flag ? get().thumbnailProgress : null,
    }),
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts
git commit -m "feat(store): add thumbnailProgress state for import progress bar"
```

---

## Task 4: Add `thumbnail:progress` event listener in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Import `setThumbnailProgress` from store**

In `App.tsx`, find the `useStore` destructure on line 14:

```typescript
  const markThumbnailReady = useStore((s) => s.markThumbnailReady);
```

Add below it:

```typescript
  const setThumbnailProgress = useStore((s) => s.setThumbnailProgress);
```

- [ ] **Step 2: Add `thumbnail:progress` listener**

After the existing `useEffect` for `thumbnail:done` (ends around line 42), add a new `useEffect`:

```typescript
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ completed: number; total: number }>("thumbnail:progress", (e) => {
      setThumbnailProgress(e.payload);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setThumbnailProgress]);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): listen to thumbnail:progress events"
```

---

## Task 5: Add i18n key for progress label

**Files:**
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 1: Add key to `zh.ts`**

In `src/i18n/zh.ts`, inside `assetGrid: { ... }` (after line 121 `rename: ...`), add:

```typescript
    generatingThumbnails: "正在生成缩略图… {{completed}}/{{total}}",
```

- [ ] **Step 2: Add key to `en.ts`**

In `src/i18n/en.ts`, inside the matching `assetGrid: { ... }` block (same relative position), add:

```typescript
    generatingThumbnails: "Generating thumbnails… {{completed}}/{{total}}",
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/zh.ts src/i18n/en.ts
git commit -m "i18n: add generatingThumbnails key"
```

---

## Task 6: Add progress bar UI in `AssetGrid.tsx`

**Files:**
- Modify: `src/components/AssetGrid.tsx`

- [ ] **Step 1: Read `thumbnailProgress` from store**

In `AssetGrid.tsx`, near line 50 where `importing` is read from store, add:

```typescript
  const thumbnailProgress = useStore((s) => s.thumbnailProgress);
```

- [ ] **Step 2: Add progress bar JSX**

Find the existing importing spinner block (around line 191–196):

```tsx
      {loading && totalCount === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[#4A4F5A] text-xs">
          <div className="w-5 h-5 rounded-full border-2 border-indigo-500/30 border-t-indigo-400 animate-spin" />
          <span>{t("assetGrid.loading")}</span>
        </div>
      )}
```

Add a new block **before** this block (i.e., insert just before it) to show the thumbnail generation progress:

```tsx
      {importing && thumbnailProgress && (
        <div className="px-3 py-2 flex flex-col gap-1.5 border-b border-zinc-800/60">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>{t("assetGrid.generatingThumbnails", {
              completed: thumbnailProgress.completed,
              total: thumbnailProgress.total,
            })}</span>
            <span className="text-zinc-500">
              {Math.round((thumbnailProgress.completed / thumbnailProgress.total) * 100)}%
            </span>
          </div>
          <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 rounded-full transition-all duration-200"
              style={{
                width: `${(thumbnailProgress.completed / thumbnailProgress.total) * 100}%`,
              }}
            />
          </div>
        </div>
      )}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Build the full app**

```bash
cd /Users/ry2019/private/FujiSim && pnpm build 2>&1 | tail -30
```

Expected: build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/AssetGrid.tsx
git commit -m "feat(ui): show thumbnail generation progress bar during import"
```

---

## Task 7: Manual smoke test

- [ ] **Step 1: Start dev server**

```bash
cd /Users/ry2019/private/FujiSim && pnpm tauri dev
```

- [ ] **Step 2: Import a directory containing RAW files**

Click "导入目录", select a folder with several RAW files (ARW, CR2, RAF, etc.).

Expected behavior:
- Import button shows "导入中…" spinner (as before)
- As soon as the first thumbnail is generated, a progress bar appears at the top of the asset list area showing "正在生成缩略图… X/Y"
- Progress bar fills from left to right as each thumbnail completes
- When 100% is reached, the progress bar disappears and the full asset list is shown — all items have thumbnails immediately visible (no lazy loading after)

- [ ] **Step 3: Verify import with no RAW files**

Import a folder containing only JPEGs. Expected: no progress bar appears, import completes normally.

- [ ] **Step 4: Verify `generate_thumbnails` command still works**

If there's a UI path to call `generate_thumbnails` (e.g., context menu "重新生成封面"), trigger it on a few assets. Expected: thumbnails regenerate in background (detached, no blocking), as before.

---

## Self-Review Checklist (done inline)

- ✅ `import:done` now emits AFTER `run_cover_generation` completes in both `import_directory` and `import_files`
- ✅ `thumbnail:done` events still emitted per-asset inside `run_cover_generation` (frontend `markThumbnailReady` still works)
- ✅ `thumbnail:all_done` still emitted at end (any other listeners unaffected)
- ✅ `spawn_cover_worker` (used by `generate_thumbnails`) delegates to `run_cover_generation` via `tokio::spawn` — stays non-blocking
- ✅ Progress bar only shown when `importing && thumbnailProgress !== null` — no flicker on non-RAW imports
- ✅ `thumbnailProgress` cleared to null when `setImporting(false, ...)` is called
- ✅ Both zh + en i18n keys added
- ✅ No `shadcn/ui Progress` component required — plain Tailwind div avoids adding a new dependency

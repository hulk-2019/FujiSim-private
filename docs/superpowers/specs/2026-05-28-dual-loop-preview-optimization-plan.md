# Dual-Loop Preview Optimization Plan

Date: 2026-05-28

## Goal

Move the editor preview toward a Lightroom-like dual-loop model:

- **Interaction loop:** frontend WebGL gives immediate visual feedback for cheap approximations.
- **Authority loop:** backend Rust/WGPU remains the only source of truth for settled preview, tile preview, histogram, and export.

This keeps interaction responsive without creating two full rendering engines.

## Current State

Already implemented:

- Backend authoritative pipeline through Rust/WGPU.
- Frontend WebGL approximation for slider dragging.
- Backend preview modes: `interactive`, `settled`, `full`, `tile`.
- `interactive` and `settled` return encoded bytes over IPC instead of temp files.
- Full preview is delayed until zoom and filter changes are idle.
- Preview/histogram use non-queueing concurrency.
- Export and cover queues pause starting new low-priority work while preview is active.
- RAW baseline TIFF uses deterministic path: `raw_originals/{asset_id}_baseline.tif`.

Gaps:

- Applying presets now uses the WebGL approximation handoff path for immediate visual response.
- Tile mode exists in backend/API, but frontend viewport tile orchestration/cache is not implemented.
- Tile transport still uses encoded image bytes; no RGBA/canvas compositor yet.
- Scheduling logic is partially centralized but not a full workload coordinator.

## Architecture

```text
Interaction Loop
  slider drag / preset click
    -> WebGL approximation from current baseline/preview texture
    -> immediate canvas overlay

Debounce / idle
  300-500ms for settled preview
  longer idle for full/tile detail refinement

Authority Loop
  backend Rust/WGPU
    -> settled preview / tile preview / histogram / export
    -> replaces WebGL approximation
```

The frontend WebGL layer is disposable. It may only approximate cheap global operations. The backend result always wins.

## Phase 1: Preset WebGL Approximation

Status: initial implementation complete.

### Behavior

When the user applies a preset:

- UI updates filter state immediately.
- WebGL approximation renders the approximable subset immediately.
- Backend `settled` preview is debounced.
- Backend result replaces WebGL when loaded.

### Approximation Scope

Allowed:

- exposure
- brightness
- contrast
- white balance
- saturation/vibrance
- simple highlight/shadow/white/black segments
- simple HSL
- simple split toning in the future

Skipped or backend-only:

- precise LUT matching
- precise tone curve
- grain
- clarity/sharpness/detail
- dehaze
- lens correction
- geometry correction
- masks/local adjustments

### Implementation Notes

- Extend current `GpuInteractivePreviewCanvas` usage beyond `isAdjustingFilter`.
- Add interaction state:
  - `idle`
  - `dragging`
  - `preset_applied`
  - `settling`
  - `authoritative_ready`
- Keep WebGL visible through handoff until backend preview image has loaded.
- Do not start `full` preview from preset application; full remains idle-only refinement.

Implemented:

- `filterInteraction` state tracks `idle`, `dragging`, `preset_applied`, and `settling`.
- Preset application marks `preset_applied`.
- PreviewPanel keeps WebGL approximation visible for preset and settling states.
- Backend preview remains authoritative and clears the approximation on image load.

## Phase 2: Frontend Tile Orchestration

Status: stable visible-tile grid, memory cache, and backend tile scheduling complete.

Backend already supports `tile` mode. The missing piece is a frontend tile compositor/cache.

### Tile Request

```ts
type PreviewTileRequest = {
  x: number;
  y: number;
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
};
```

### Trigger

Use tile preview when:

- zoom exceeds the settled-preview quality threshold,
- filter is idle,
- zoom/pan is idle,
- viewport has valid image coordinate mapping.

### Cache Key

```text
asset_id
filter_hash
zoom_bucket
tile_x
tile_y
pipeline_version
```

### Display

- Base layer: existing 1920 settled preview.
- Detail layer: loaded tile images positioned above the base layer.
- Missing/loading tiles should not show skeletons.
- Pan/zoom cancels requests for no-longer-visible tiles.

Implemented:

- `useTilePreview` computes the visible image region from viewport, pan, and zoom.
- Tile requests use backend `tile` mode.
- Loaded tile detail is overlaid above the settled preview.
- Tile loading does not show skeletons or replace the settled base preview.
- High-zoom editor preview now keeps the settled 1920 base layer and refines only visible tiles.
- The frontend splits the visible image region into stable 1024px source tiles with a small prefetch margin.
- Tile images are cached in memory with an LRU cap and keyed by asset, filter, zoom bucket, tile coordinate, and tile pipeline version.
- Tile requests now use a backend `tile_token` separate from the main preview token, so detail refinement no longer cancels settled/interactive preview.
- The frontend tile loader uses a small capped concurrency while backend preview semaphore still protects CPU/GPU load.
- Tile refinement has a dedicated backend `tile_sem` capped at 2, keeping main preview and tile detail scheduling separate.
- Obsolete tile batches are aborted on the frontend before they continue requesting later tiles.

Remaining:

- Evaluate persistent tile cache only after measuring cross-session reuse value.

### Transport

Short term:

- keep encoded tile bytes and Blob URLs.
- this reuses current image display path and is lower risk.
- keep tile transport as JPEG initially; WebP support exists in the encoder but should only be enabled after measuring encode/decode cost on large RAW previews.

Long term:

- use RGBA tile buffers only after adding a canvas/WebGPU tile compositor.
- otherwise RGBA increases IPC and memory pressure without replacing the `<img>` path.
- canvas/WebGPU compositor remains a separate implementation step because the current `<img>` overlay is already functional and lower risk.

## Phase 3: Workload Coordinator

Status: initial low-priority admission control complete.

### Proposed State

```rust
preview_active_until_ms
interaction_active_until_ms
export_running_count
cover_running_count
```

### Rules

- Preview has highest priority.
- Histogram skips while preview is busy or interaction is active.
- Export does not start new tasks while preview/interaction is active.
- Cover queue does not start new jobs while preview/interaction is active.
- Running export tasks are not killed; only new starts are paused.

### API

```rust
mark_preview_active_for(ms)
mark_interaction_active_for(ms)
preview_is_active()
interaction_is_active()
low_priority_work_can_start()
```

Implemented:

- Added `interaction_active_until_ms` alongside `preview_active_until_ms`.
- Added `mark_preview_interaction` IPC so frontend WebGL-only interaction can still make background work yield.
- Export and cover queues now wait on `low_priority_work_can_start()`.
- Histogram returns `preview_busy` while interaction is active and the frontend retry path handles it.
- Main preview, tile detail, histogram, export, and cover queues now have distinct scheduling/cancellation channels.

Remaining:

- Move queue policy into a dedicated coordinator module if more workload classes are added.

## Cache Path and SQLite Policy

### Current RAW Baseline TIFF

Current path:

```text
<data_dir>/raw_originals/{asset_id}_baseline.tif
```

This is deterministic from `asset_id`, so it does **not** need to be stored in `assets`.

Reasons:

- No synchronization problem between DB path and file path.
- Moving the app data directory does not require rewriting DB rows.
- Cache invalidation can be handled by filename/version convention.
- `assets` remains source-image metadata, not cache metadata.

Keep using a derived path for:

- RAW baseline TIFF.
- temporary full preview output.
- tile cache files if the filename can be deterministic.

### When SQLite Is Worth It

Use SQLite for cache metadata only when the cache is no longer trivially derivable.

Recommended future table:

```sql
CREATE TABLE IF NOT EXISTS asset_render_cache (
    asset_id INTEGER NOT NULL,
    cache_kind TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    pipeline_version INTEGER NOT NULL,
    filter_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (asset_id, cache_kind, cache_key)
);
```

Use this table for:

- multi-version tile caches,
- persistent rendered previews for specific filter hashes,
- cache eviction by last access time,
- pipeline-version invalidation,
- cross-session warm cache discovery.

Implemented:

- `asset_render_cache` schema and DB helper module exist.
- Current tile cache remains memory-only; no disk writes are performed until persistent cache value is proven by profiling.

Do **not** add `baseline_tiff_path` to `assets` unless the baseline file can live outside the deterministic cache directory.

## Implementation Order

1. Add preset WebGL approximation state and handoff. Done.
2. Add tile viewport orchestration and in-memory tile cache. Done.
3. Add persistent `asset_render_cache` schema for future persistent render caches. Done.
4. Centralize preview/interaction activity into initial workload admission rules. Done.
5. Evaluate WebP vs JPEG for tile transport. Deferred to profiling; default remains JPEG.
6. Add RGBA/canvas compositor only after tile overlays prove too costly. Deferred by design.

## Acceptance Criteria

- Slider drag does not trigger backend preview when WebGL source exists.
- Applying presets gives immediate visual feedback without immediate full render.
- Backend settled preview replaces WebGL after debounce.
- High-zoom viewing does not require whole-image full render.
- Tile requests are limited to visible viewport tiles.
- Export/cover/histogram do not starve focused preview.
- `assets` table does not store deterministic cache paths.
- Any future persistent render cache uses a dedicated cache metadata table.

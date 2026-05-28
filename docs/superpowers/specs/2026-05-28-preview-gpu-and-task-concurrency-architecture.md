# Preview GPU and Task Concurrency Architecture

Date: 2026-05-28

## Problem

The editor currently has two related performance issues:

- High-frequency edits can still trigger expensive preview work, especially on large images.
- Background work such as export, cover extraction, histogram, and preview can run at the same time and contend for CPU, GPU, disk IO, and memory bandwidth.

The existing preview path also still pays avoidable costs:

```text
render/process image
  -> read back to CPU
  -> encode JPEG
  -> write temporary file
  -> WebView loads <img>
  -> browser decodes JPEG
```

Even when the pixel pipeline itself uses WGPU, encode, write, decode, and task contention can push CPU usage above one core during editing.

## Goals

- Keep Rust/WGPU as the single authoritative rendering pipeline for settled preview, full preview, export, histogram, and future editing tools.
- Use frontend WebGL only as an interactive approximation layer.
- Avoid running stale preview work.
- Prevent background tasks from starving interactive preview.
- Prepare for future features: split toning, color range, lens correction, geometry correction, masking, and tile preview.

## Non-goals

- Reimplement the full Lightroom-like engine in frontend WebGL.
- Replace LibRaw RAW decode with GPU demosaic in this phase.
- Guarantee that drag-time WebGL approximation exactly matches export.

## Pipeline Roles

### Authoritative Backend WGPU

Backend WGPU is the source of truth for:

- settled preview
- full-resolution preview
- export
- authoritative histogram
- future lens/geometry/color range/masking operations

### Frontend WebGL Approximation

Frontend WebGL is only for:

- slider drag feedback
- short preset/filter settling window
- low-latency visual approximation while backend work is deferred

The UI must replace WebGL approximation with backend authoritative preview after interaction settles.

### Single Authority Boundary

The project must not maintain two complete render engines.

Backend Rust/WGPU remains the only source of truth for:

- final pixel values
- settled/full preview
- export
- histogram used for editing decisions
- feature-complete implementations of tone curve, LUT, grain, detail, dehaze, lens correction, geometry, masks, and local adjustments

Frontend WebGL may only implement bounded, low-cost approximations for interaction:

- exposure
- brightness/contrast
- white balance
- saturation/vibrance
- coarse tone segments
- simple HSL
- simple split toning in the future

Frontend WebGL must not implement authoritative versions of:

- LUT matching
- tone curve precision
- grain
- clarity/sharpness/detail
- dehaze
- lens correction
- geometry correction
- masks/local adjustments
- export output

If a feature needs exact parity, it belongs in backend Rust/WGPU. The frontend should either skip it during drag or display an approximate direction, then replace it with the backend result after settling.

## Current CPU/Contention Sources

### Preview

- RAW/image base decode or TIFF base read.
- WGPU upload/process/readback.
- JPEG encode.
- temporary file write.
- WebView image decode.

### Histogram

- May share preview base but still processes an image and computes bins.
- Can contend with preview if scheduled at the same time.

### Export

- Full-resolution decode/process/resize/encode.
- Uses rayon pool and can consume CPU while editing continues.
- Can compete with preview for WGPU and memory bandwidth.

### Cover Queue

- Background cover extraction and writing.
- Can overlap with preview navigation and import.

### Import/EXIF

- Mostly IO and metadata parsing, but can overlap with thumbnail generation.

## Task Priority Model

Recommended priority from highest to lowest:

1. Interactive UI events and WebGL drag preview.
2. Backend settled preview for the focused image.
3. Histogram for focused image.
4. Visible asset strip cover generation.
5. Export.
6. Background import/EXIF and non-visible cover work.

## Concurrency Rules

### Preview

- Never queue stale preview requests.
- At most one backend preview should run.
- If busy, return immediately and let frontend keep only the latest pending state.
- Drag-time preview should prefer frontend WebGL and avoid backend work when a base texture exists.
- Full-resolution preview is a low-priority detail refinement. It must wait for
  both zoom idle and filter idle, so presets and slider releases do not
  immediately trigger native-resolution rendering.

### Histogram

- Do not run during slider drag.
- Use try-acquire behavior.
- If preview is busy, histogram should skip and retry on next settled state.
- If a preview request arrives while histogram is running, histogram should
  self-cancel at the next checkpoint and release the shared preview permit.

### Export

- Export should not run with high parallelism while the editor is actively interacting.
- Export concurrency should default to 1 for interactive desktop editing.
- Export dispatcher pauses starting new tasks while preview/interaction is active.

### Cover Queue

- Cover generation should not consume multiple blocking workers during active editing.
- Default cover concurrency should be conservative.
- Cover queue pauses starting new jobs while preview/interaction is active.
- Long-term: cover queue should have visible-item priority.

## Rendering Evolution

### Phase 1: Scheduling and Contention Control

- Preview/histogram use non-queueing semaphore acquisition.
- Frontend coalesces preview requests.
- Busy preview immediately becomes pending latest state.
- Reduce interactive backend preview size and JPEG quality.
- Lower export and cover concurrency defaults to protect interactive editing.

### Phase 2: Frontend WebGL Approximation

- Keep WebGL canvas warm.
- Limit WebGL backing-store resolution.
- Approximate global adjustments in WebGL:
  - exposure
  - brightness
  - contrast
  - white balance
  - saturation/vibrance
  - tone segments
  - simple HSL
  - simple split toning
- Backend WGPU replaces the approximation after settling.

### Phase 3: Explicit Preview Modes

Replace implicit `max_edge` inference with a preview mode:

```text
interactive
settled
full
tile
```

Each mode defines:

- max edge or region
- quality
- disk persistence behavior
- whether detail passes are enabled
- whether histogram should follow

### Phase 4: Remove Temporary JPEG File Bottleneck

Step 1:

- Return backend-authoritative encoded preview bytes over IPC for `interactive` and `settled` modes.
- Frontend creates Blob URL.
- Avoid temp file writes and WebView disk re-read for common preview updates.
- Keep `full` mode on file transport until tile/region preview exists, to avoid very large IPC payloads.

Step 2:

- Return RGBA/tile buffers for interactive or tile preview.
- Avoid JPEG encode/decode for small/tile previews.

Status: settled and interactive previews already avoid temporary files. Tile
mode currently uses the same encoded Blob image transport so it can plug into
the existing display path. Raw RGBA tile transport should be added together
with a canvas/WebGPU tile compositor; otherwise it creates an unused second
frontend rendering path.

### Phase 5: Tile/Region Preview

Needed for:

- 1:1 preview
- large RAW files
- lens correction
- geometry correction
- local masks

Recommended tile design:

- tile size: 512 or 1024
- overlap: 16-32 px
- cache key: asset id, filter hash, zoom level, tile x/y, pipeline version

Implemented foundation:

- Backend IPC supports `tile` preview mode.
- Tile requests specify source `x/y/width/height` and output `outputWidth/outputHeight`.
- Tile mode uses the same authoritative backend WGPU pipeline as settled preview.
- Tile mode reads native base input rather than rendering a whole-image `full` preview first.
- Frontend API/types can request tiles; viewport orchestration and tile cache are separate UI-layer work.

### Phase 6: GPU Histogram

Drag-time:

- frontend WebGL approximate histogram from current framebuffer.

Settled:

- backend WGPU authoritative histogram from processed preview or a 512 base.

## Future Feature Fit

### Split Toning

- Backend WGPU authoritative implementation.
- Frontend WebGL approximation is acceptable.

### Color Range

- Backend WGPU mask generation and application.
- Frontend WebGL can approximate mask preview.
- Needs tile/mask texture planning.

### Lens Correction

- Backend WGPU only for authoritative output.
- Avoid full duplicate frontend implementation.
- Needs inverse coordinate mapping and edge handling.

### Geometry Correction

- Backend WGPU authoritative.
- Tile/region preview strongly recommended before full feature.

### Local Adjustments and Masks

- Backend WGPU authoritative.
- Frontend handles overlay/mask interaction.
- Tile cache and mask textures become necessary.

## Implementation Order

1. Document and enforce conservative task concurrency defaults. Done.
2. Keep frontend WebGL approximation warm and bounded. Done.
3. Extend WebGL approximation for tone segments and HSL. Done for current bounded approximation scope.
4. Add preview mode enum to backend IPC. Done.
5. Add preview timing instrumentation. Done.
6. Replace temp-file preview path with Blob bytes for `interactive` and `settled` modes, while keeping backend WGPU authoritative. Done.
7. Add tile preview foundation. Done.
8. Add backend WGPU implementations for future Lightroom-like features. Tracked as separate feature work.

## Current Implementation Status

Implemented:

- `get_preview` uses explicit `interactive`, `settled`, `full`, and `tile` modes.
- Backend preview uses a non-queueing shared permit; busy requests return immediately.
- Frontend coalesces preview requests with tokens and keeps only latest pending state.
- Drag-time slider changes use frontend WebGL approximation when a baseline source exists.
- Full-resolution preview is delayed until zoom and filter changes are idle.
- WebGL remains an approximation layer; backend WGPU output replaces it after settling.
- `interactive` and `settled` previews return encoded bytes over IPC and use Blob URLs.
- `full` preview remains path-based to avoid very large IPC payloads.
- `tile` preview mode returns encoded bytes for native-resolution visible-region refinement.
- Preview timing instrumentation records base decode, processing, encode, transport, and total time.
- Histogram does not run while sliders are actively dragging.
- Histogram uses try-acquire behavior and returns `preview_busy` instead of queueing behind preview.
- Histogram self-cancels if a newer preview request arrives while it is running.
- Export task concurrency and cover generation defaults are conservative.
- Export and cover queues pause starting lower-priority work while preview is active.

Remaining:

- Add frontend tile viewport orchestration and cache.
- Add RGBA tile compositor if/when tile display moves from `<img>` overlays to canvas/WebGPU.
- Implement future Lightroom-like tools as separate backend WGPU feature projects.

## Acceptance Criteria

- Dragging sliders does not start backend preview work when a WebGL source is available.
- Applying presets does not immediately start full backend rendering; it waits for settling.
- Preview and histogram do not queue stale work.
- Export and cover tasks no longer use enough concurrency to starve interactive preview by default.
- Settled preview and export continue to use the same backend authoritative pipeline.
- Frontend WebGL approximation is always replaced by backend output after settling.
- New editing features default to backend Rust/WGPU unless they are explicitly bounded as drag-time approximations.

# Lightroom-like RAW Preview Architecture

Date: 2026-05-27

## Problem

The current RAW preview flow mixes two different image products:

- Embedded JPEG extracted from the RAW file.
- App-rendered RAW decode output.

Embedded JPEGs are camera-rendered images with vendor tone curves, dynamic range behavior, color modes, and sharpening. They are useful for fast loading, but they are not a stable editing baseline. Trying to match them with global gain or histogram curves is fragile and scene-dependent.

For a Lightroom-like editor, the app must define its own RAW default develop result. The "original" shown in the editor should mean "default develop without user edits", not "camera embedded JPEG".

## Goals

- Make RAW identity preview, edited preview, histogram, original toggle, and export share one baseline develop strategy.
- Keep embedded JPEG only as a temporary loading placeholder.
- Avoid brightness jumps when a user changes any edit parameter.
- Reduce CPU load during slider interaction by avoiding unnecessary histogram work and stale preview encoding.
- Keep the implementation incremental and compatible with current IPC boundaries.

## Non-goals

- Pixel-match camera JPEG rendering.
- Fully implement Adobe camera profiles or DCP processing in this phase.
- Rewrite the whole rendering backend in one change.

## Definitions

### Placeholder Preview

Fast image used only while the app-rendered preview is not ready. For RAW files this is the embedded JPEG or cover image.

### Baseline Develop

The app-defined RAW default rendering. This is the visual "original" inside the editor.

Baseline develop currently includes:

- LibRaw decode.
- Camera white balance.
- Camera matrix.
- LibRaw auto-bright disabled.
- Fixed app baseline tone curve.
- Output as 16-bit RGB preview base.

### Edited Preview

Baseline develop plus user edit parameters.

When the filter is identity, edited preview equals baseline develop.

## Target Flow

```text
RAW file
  ├─ embedded JPEG
  │   └─ placeholder only
  └─ LibRaw decode
      └─ app baseline develop
          ├─ baseline preview 1920
          │   └─ edited preview
          ├─ baseline preview 512
          │   └─ histogram
          └─ full-resolution baseline develop
              └─ export
```

## Frontend Behavior

### RAW Load

1. Show embedded JPEG or cover as placeholder.
2. Request `getPreview(...identity...)`.
3. When preview returns, display app baseline develop.
4. From this point, do not use embedded JPEG for the editor's visible original.

### Show Original

For RAW:

- `showOriginal=true`: display baseline develop preview.
- `showOriginal=false`: display edited preview.

For regular images:

- Keep existing behavior: original source image versus edited preview.

### Histogram

- Do not calculate during slider drag.
- Recalculate after drag settles.
- Use baseline 512 path or resized baseline cache.

## Backend Behavior

### RAW Decode

LibRaw parameters:

- `use_camera_wb = true`
- `use_camera_matrix = true`
- `no_auto_bright = 1`
- `bright = 1.0`

After LibRaw process, apply a fixed app baseline tone curve. This curve is not fitted to the embedded JPEG. It is the app's default rendering intent.

### Cache Versioning

Use a new cache version when baseline develop changes.

Example:

```text
{asset_id}_baseline.tif
```

This avoids using old caches produced by JPEG-matching experiments.

### Cancellation

Preview and histogram tasks should check tokens:

- after base decode/read;
- after processing;
- before expensive encode/write.

This does not cancel GPU kernels mid-dispatch, but it avoids stale JPEG encoding and file writes.

## Performance Roadmap

### Phase 1

- Remove embedded JPEG tone matching.
- Add fixed baseline tone curve.
- Change RAW original toggle to use baseline preview.
- Keep current disk cache.
- Pause histogram while sliders are being dragged.
- Add additional token checks.

### Phase 2

- Add in-memory LRU cache for preview bases.
- Share cache between preview and histogram.
- Avoid decoding TIFF from disk on every parameter change.

### Phase 3

- Separate interactive preview resolution from settled preview resolution.
- During slider drag, render at 1280 long edge.
- After release, render final 1920 long edge preview and histogram.

### Phase 4

- Revisit full-resolution export to ensure it uses the same baseline develop strategy.
- Add optional camera-like profile mode only if product needs it, separate from the default Lightroom-like baseline.

## Acceptance Criteria

- RAW identity display and edited display use the same app baseline.
- Toggling original on RAW does not return to embedded JPEG once baseline is available.
- Adjusting grain/detail/basic sliders does not cause a source switch from embedded JPEG to RAW decode.
- Slider drag no longer continuously triggers histogram calculation.
- Old preview requests avoid encoding/writing files when stale.

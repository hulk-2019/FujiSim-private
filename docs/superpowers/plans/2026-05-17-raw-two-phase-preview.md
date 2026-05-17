# RAW Two-Phase Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate CPU spikes and blank-screen flicker when switching RAW/DNG files by showing an embedded JPEG thumbnail immediately (phase 1) and upgrading to full-quality decoded preview only after the user has settled on a file for 300ms (phase 2).

**Architecture:** `PreviewPanel` gains a `thumbSrc` state that is populated instantly from the disk-cached thumbnail (`thumbnailDir/{id}.jpg` via `convertFileSrc`) or `convertFileSrc(file_path)` for non-RAW files. The existing `preview` state (full `getPreview` result) is unchanged but its debounce is raised from 150ms to 300ms. While the full preview is loading, the thumbnail is shown as a placeholder; once the full preview arrives it replaces the thumbnail seamlessly. Fast switching (< 300ms) never triggers a backend call.

**Tech Stack:** React (useState, useEffect, useRef), Zustand store (`rawThumbnailReady`, `thumbnailDir`), Tauri `convertFileSrc`, existing `api.getPreview`.

---

### Task 1: Raise debounce and wire phase-1 thumbnail in PreviewPanel

**Files:**
- Modify: `src/components/PreviewPanel.tsx`

This task replaces the single-phase render with a two-phase approach entirely inside `PreviewPanel`. No backend changes needed.

**Current behaviour (lines 49-73 of PreviewPanel.tsx):**
```tsx
// 150ms debounce → getPreview immediately on focus change
useEffect(() => {
  if (!focused) { setPreview(null); return; }
  setError(null);
  const myId = ++reqId.current;
  setLoading(true);
  const handle = setTimeout(async () => {
    try {
      const r = await api.getPreview(focused.id, filter, 1280);
      if (reqId.current === myId) {
        setPreview(r);
        setPreviewSize({ width: r.width, height: r.height }, focused.id);
        setLoading(false);
      }
    } catch (e) {
      if (reqId.current === myId) { setError(String(e)); setLoading(false); }
    }
  }, 150);
  return () => clearTimeout(handle);
}, [focused?.id, filter]);
```

- [ ] **Step 1: Add `thumbSrc` state and populate it immediately on focus change**

In `PreviewPanel.tsx`, add two new imports and one new state variable, then add a new `useEffect` that fires synchronously (no debounce) when `focused` changes:

```tsx
// add to existing imports at top of file
import { convertFileSrc } from "@tauri-apps/api/core"; // already imported — no change needed
```

Add after the existing `const [originalError, setOriginalError] = useState<string | null>(null);` line:

```tsx
const [thumbSrc, setThumbSrc] = useState<string | null>(null);
const rawThumbnailReady = useStore((s) => s.rawThumbnailReady);
const thumbnailDir = useStore((s) => s.thumbnailDir);
```

Add a new `useEffect` immediately after the `useEffect` that clears `originalPreview` on focus change (after line 47):

```tsx
// Phase 1: show thumbnail immediately, no backend call
useEffect(() => {
  if (!focused) {
    setThumbSrc(null);
    return;
  }
  if (focused.is_raw) {
    if (rawThumbnailReady.has(focused.id) && thumbnailDir) {
      try {
        setThumbSrc(convertFileSrc(`${thumbnailDir}/${focused.id}.jpg`));
      } catch {
        setThumbSrc(null);
      }
    } else {
      setThumbSrc(null);
    }
  } else {
    try {
      setThumbSrc(convertFileSrc(focused.file_path));
    } catch {
      setThumbSrc(null);
    }
  }
}, [focused?.id, focused?.file_path, focused?.is_raw, rawThumbnailReady, thumbnailDir]);
```

- [ ] **Step 2: Raise debounce from 150ms to 300ms and clear preview on focus change**

In the existing `getPreview` effect, change the debounce and add an immediate preview clear so the stale previous image doesn't linger while the new one loads:

Replace the existing effect (lines 49-73) with:

```tsx
useEffect(() => {
  if (!focused) {
    setPreview(null);
    setLoading(false);
    return;
  }
  // Clear stale full preview immediately so we fall back to thumbSrc
  setPreview(null);
  setError(null);
  const myId = ++reqId.current;
  setLoading(true);
  const handle = setTimeout(async () => {
    try {
      const r = await api.getPreview(focused.id, filter, 1280);
      if (reqId.current === myId) {
        setPreview(r);
        setPreviewSize({ width: r.width, height: r.height }, focused.id);
        setLoading(false);
      }
    } catch (e) {
      if (reqId.current === myId) {
        setError(String(e));
        setLoading(false);
      }
    }
  }, 300);
  return () => clearTimeout(handle);
}, [focused?.id, filter]);
```

- [ ] **Step 3: Update the render to use `thumbSrc` as placeholder while full preview loads**

The render section currently shows `previewSrc` (from `preview`) or nothing. Replace the image display block so that:
- When `preview` is available → show full preview (existing behaviour)
- When `preview` is null but `thumbSrc` is available → show thumbnail as placeholder
- When both are null → show nothing (loading spinner still shows)

Find the block starting with `{!showOriginal && previewSrc && (` (around line 152) and replace the entire `{!showOriginal && ...}` block with:

```tsx
{!showOriginal && (previewSrc ?? thumbSrc) && (
  <div
    ref={containerRef}
    className="relative max-w-full max-h-full shadow-2xl"
    style={
      preview
        ? { aspectRatio: `${preview.width} / ${preview.height}` }
        : focused?.width && focused?.height
        ? { aspectRatio: `${focused.width} / ${focused.height}` }
        : undefined
    }
  >
    <img
      src={(previewSrc ?? thumbSrc)!}
      alt="preview"
      className="w-full h-full object-contain no-drag"
    />
    {watermark.enabled && preview && previewContainerSize && (
      <WatermarkOverlay
        wm={watermark}
        previewW={preview.width}
        previewH={preview.height}
        containerW={previewContainerSize.width}
      />
    )}
  </div>
)}
```

- [ ] **Step 4: Verify the loading indicator still shows correctly**

The loading indicator (`{loading && ...}`) is already rendered as an absolute overlay — no change needed. Confirm it is still present in the JSX after your edits. It should read:

```tsx
{loading && (
  <div className="absolute top-3 left-3 text-xs text-zinc-400 bg-zinc-950/60 px-2 py-1 rounded">
    {t("previewPanel.rendering")}
  </div>
)}
```

- [ ] **Step 5: Commit**

```bash
git add src/components/PreviewPanel.tsx
git commit -m "feat: two-phase RAW preview — thumbnail placeholder + 300ms debounce for full decode"
```

---

### Task 2: Handle thumbnail becoming ready after initial render

**Files:**
- Modify: `src/components/PreviewPanel.tsx`

When a RAW file is focused before its thumbnail has been generated (`rawThumbnailReady` doesn't contain the id yet), `thumbSrc` is null. The `thumbnail:done` event fires later and updates `rawThumbnailReady` in the store. The phase-1 effect already depends on `rawThumbnailReady`, so React will re-run it automatically — but only if the focused asset is still the same one.

- [ ] **Step 1: Verify the dependency array is correct**

Open `src/components/PreviewPanel.tsx` and confirm the phase-1 `useEffect` added in Task 1 has `rawThumbnailReady` in its dependency array:

```tsx
}, [focused?.id, focused?.file_path, focused?.is_raw, rawThumbnailReady, thumbnailDir]);
```

`rawThumbnailReady` is a `Set<number>` stored in Zustand. Zustand replaces the set reference on every `markThumbnailReady` call (see `store.ts` line 442-445: `const next = new Set(...); next.add(assetId); set({ rawThumbnailReady: next })`), so React's referential equality check will correctly detect the change and re-run the effect.

No code change needed — this is a verification step only.

- [ ] **Step 2: Confirm in the browser**

Start the dev server:
```bash
npm run tauri dev
```

1. Import a folder of RAW files for the first time (thumbnails not yet cached).
2. Click a RAW file immediately after import — you should see the loading spinner (no thumbnail yet).
3. Wait a few seconds — the `thumbnail:done` event fires, `rawThumbnailReady` updates, and the thumbnail should appear in the preview panel without any user interaction.
4. Click another RAW file whose thumbnail is already cached — it should appear instantly with no blank frame.

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "chore: verify thumbnail-ready reactive update works correctly"
```

---

### Task 3: Suppress redundant `getPreview` calls when filter hasn't changed

**Files:**
- Modify: `src/components/PreviewPanel.tsx`

Currently the `getPreview` effect depends on both `focused?.id` and `filter`. When the user switches assets, `filter` hasn't changed — only `focused?.id` has. This is fine. But if the user switches assets rapidly and then changes a filter slider, the effect fires again for the same asset. This task adds a guard to avoid re-fetching when the asset id hasn't changed and the full preview is already loaded.

- [ ] **Step 1: Add a ref to track the last successfully fetched asset+filter combo**

Add after the existing `const reqId = useRef(0);` line:

```tsx
const lastFetchedRef = useRef<{ assetId: number; filterKey: string } | null>(null);
```

- [ ] **Step 2: Skip the fetch if result is already cached in state**

Inside the `getPreview` effect, add an early-return guard right after `setPreview(null)`:

```tsx
useEffect(() => {
  if (!focused) {
    setPreview(null);
    setLoading(false);
    lastFetchedRef.current = null;
    return;
  }
  const filterKey = JSON.stringify(filter);
  // Already have the result for this exact asset+filter — skip
  if (
    lastFetchedRef.current?.assetId === focused.id &&
    lastFetchedRef.current?.filterKey === filterKey
  ) {
    return;
  }
  setPreview(null);
  setError(null);
  const myId = ++reqId.current;
  setLoading(true);
  const handle = setTimeout(async () => {
    try {
      const r = await api.getPreview(focused.id, filter, 1280);
      if (reqId.current === myId) {
        lastFetchedRef.current = { assetId: focused.id, filterKey };
        setPreview(r);
        setPreviewSize({ width: r.width, height: r.height }, focused.id);
        setLoading(false);
      }
    } catch (e) {
      if (reqId.current === myId) {
        setError(String(e));
        setLoading(false);
      }
    }
  }, 300);
  return () => clearTimeout(handle);
}, [focused?.id, filter]);
```

- [ ] **Step 3: Verify filter changes still trigger re-fetch**

In the running app:
1. Open a RAW file — full preview loads.
2. Move a filter slider — preview should re-render (loading indicator appears briefly, then new preview).
3. Move the same slider back to its original value — preview should re-render again (filter key changed and changed back; the guard only skips if the key matches the *last fetched* key, which it does after step 2 restores the original value — so this is a no-op fetch that gets skipped correctly).

- [ ] **Step 4: Commit**

```bash
git add src/components/PreviewPanel.tsx
git commit -m "perf: skip redundant getPreview calls when asset+filter already fetched"
```

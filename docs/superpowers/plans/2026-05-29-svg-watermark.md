# SVG Watermark Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PNG-based watermark preview/export with an SVG-first watermark system that supports built-in recommended styles, imported SVG watermarks, SVG thumbnails, unified SVG recoloring, text overrides, and export retry from persisted settings.

**Architecture:** Add a shared TypeScript SVG generation/sanitization layer for preview thumbnails and editor overlay, plus Rust SVG import/storage and export rasterization. Remove the front-end per-asset PNG watermark payload; export tasks persist `watermark_json` and render SVG at final output size in Rust.

**Tech Stack:** React 18 + TypeScript + Zustand + i18next, Tauri 2, Rust, SQLite via sqlx, SVG rasterization with `resvg/usvg/tiny-skia`, front-end unit tests with Vitest.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Modify | Add `test` script and Vitest dev dependency |
| `vite.config.ts` | Modify | Add Vitest config for TS path aliases |
| `src/types.ts` | Modify | Extend watermark and add imported SVG types |
| `src/store/types.ts` | Modify | Extend watermark slice with SVG list/actions |
| `src/store/slices/watermark.ts` | Modify | Apply recommendations, imported SVGs, and migrated presets |
| `src/lib/watermarkSvg.ts` | Create | Build full-canvas SVG, thumbnails, text SVG, imported SVG overrides |
| `src/lib/watermarkSvg.test.ts` | Create | Unit tests for SVG generation and overrides |
| `src/components/preview/WatermarkOverlay.tsx` | Modify | Render SVG overlay directly |
| `src/components/WatermarkTab.tsx` | Modify | Recommended/custom card lists and SVG controls |
| `src/components/ExportDialog.tsx` | Modify | Stop rendering PNG watermarks and pass settings only |
| `src/api.ts` | Modify | Remove PNG layer API shape and add SVG import/list/delete calls |
| `src/i18n/en.ts` | Modify | Add SVG watermark UI strings |
| `src/i18n/zh.ts` | Modify | Add SVG watermark UI strings |
| `src-tauri/Cargo.toml` | Modify | Add SVG rasterizer dependencies |
| `src-tauri/src/state.rs` | Modify | Add `watermark_svg_dir` |
| `src-tauri/src/db/mod.rs` | Modify | Add `user_watermark_svgs` table |
| `src-tauri/src/db/watermark_svgs.rs` | Create | CRUD for imported SVG watermarks |
| `src-tauri/src/ipc/watermark.rs` | Modify | Add import/list/delete SVG commands |
| `src-tauri/src/ipc/app.rs` | Modify | Clear imported SVGs on app data reset |
| `src-tauri/src/ipc/export.rs` | Modify | Remove PNG layer save/retry path |
| `src-tauri/src/export/watermark_svg.rs` | Create | Rust SVG settings model, sanitizer, builder, rasterizer |
| `src-tauri/src/export/mod.rs` | Modify | Composite SVG watermark from settings |
| `src-tauri/src/vips_io.rs` | Modify | Remove unused PNG watermark loader after export path migrates |
| `src-tauri/src/lib.rs` | Modify | Register new SVG watermark IPC commands |

---

### Task 1: Add Front-End Test Harness

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Create: `src/lib/watermarkSvg.test.ts`

- [ ] **Step 1: Add a failing Vitest smoke test**

Create `src/lib/watermarkSvg.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildWatermarkSvg } from "@/lib/watermarkSvg";
import { DEFAULT_WATERMARK } from "@/types";

describe("buildWatermarkSvg", () => {
  it("builds a full-canvas svg for a text watermark", () => {
    const svg = buildWatermarkSvg(
      { ...DEFAULT_WATERMARK, enabled: true, kind: "text", text: "FujiSim" },
      1200,
      800,
    );

    expect(svg).toContain("<svg");
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="800"');
    expect(svg).toContain("FujiSim");
  });
});
```

- [ ] **Step 2: Add Vitest dependencies and script**

Update `package.json`:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
},
"devDependencies": {
  "vitest": "^3.2.0"
}
```

Keep existing scripts and dependencies unchanged.

- [ ] **Step 3: Add Vitest config**

Update `vite.config.ts`:

```ts
/// <reference types="vitest" />
```

Add inside `defineConfig` return object:

```ts
test: {
  environment: "node",
},
```

If TypeScript reports that `test` is not a valid Vite config property, the previous reference line must be present at the top of the file.

- [ ] **Step 4: Run test and verify red**

Run:

```bash
pnpm test src/lib/watermarkSvg.test.ts
```

Expected: FAIL because `src/lib/watermarkSvg.ts` does not exist.

- [ ] **Step 5: Commit**

```bash
git add package.json vite.config.ts src/lib/watermarkSvg.test.ts
git commit -m "test: add watermark svg test harness"
```

---

### Task 2: Extend Watermark Types and Defaults

**Files:**
- Modify: `src/types.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/slices/watermark.ts`

- [ ] **Step 1: Add failing type-level usage to the test**

Append to `src/lib/watermarkSvg.test.ts`:

```ts
it("accepts imported svg watermark settings", () => {
  const svg = buildWatermarkSvg(
    {
      ...DEFAULT_WATERMARK,
      enabled: true,
      kind: "svg",
      source: "imported",
      svgId: 7,
      svgMarkup: '<svg viewBox="0 0 10 10"><path fill="currentColor" d="M0 0h10v10H0z"/></svg>',
      svgFillOverride: "#ff0000",
      svgStrokeOverride: "#00ff00",
      svgTextOverride: "Signed",
    },
    400,
    300,
  );

  expect(svg).toContain("#ff0000");
});
```

- [ ] **Step 2: Run test and verify red**

Run:

```bash
pnpm test src/lib/watermarkSvg.test.ts
```

Expected: FAIL with TypeScript errors for missing `kind`, `source`, `svgMarkup`, and override fields.

- [ ] **Step 3: Extend `src/types.ts`**

Add near the watermark types:

```ts
export type WatermarkKind = "text" | "svg";
export type WatermarkSource = "builtin" | "imported" | "preset";

export type UserWatermarkSvg = {
  id: number;
  name: string;
  file_path: string;
  preview_svg: string | null;
  created_at: string;
  is_deleted: number;
  deleted_at?: string | null;
};
```

Extend `WatermarkSettings`:

```ts
kind: WatermarkKind;
source: WatermarkSource;
name?: string;
svgId?: number;
svgMarkup?: string;
svgTextOverride?: string;
svgFillOverride?: string;
svgStrokeOverride?: string;
svgOriginalViewBox?: string;
scale: number;
```

Update `DEFAULT_WATERMARK`:

```ts
kind: "text",
source: "builtin",
scale: 1,
```

- [ ] **Step 4: Extend store types**

In `src/store/types.ts`, import `UserWatermarkSvg`, then add to `WatermarkSlice`:

```ts
userWatermarkSvgs: UserWatermarkSvg[];
refreshUserWatermarkSvgs: () => Promise<void>;
importWatermarkSvgs: (paths: string[]) => Promise<UserWatermarkSvg[]>;
removeUserWatermarkSvg: (id: number) => Promise<void>;
applyImportedWatermarkSvg: (svg: UserWatermarkSvg) => void;
```

- [ ] **Step 5: Add temporary no-op store shape**

In `src/store/slices/watermark.ts`, initialize:

```ts
userWatermarkSvgs: [],
```

Temporarily implement actions without backend calls. Task 4 replaces these no-ops after the API methods exist:

```ts
refreshUserWatermarkSvgs: async () => {},
importWatermarkSvgs: async (paths) => {
  void paths;
  return [];
},
removeUserWatermarkSvg: async (id) => {
  void id;
},
applyImportedWatermarkSvg: (svg) => {
  set({
    watermark: {
      ...get().watermark,
      enabled: true,
      kind: "svg",
      source: "imported",
      svgId: svg.id,
      svgMarkup: svg.preview_svg ?? "",
      name: svg.name,
    },
    selectedWatermarkPresetId: null,
  });
},
```

- [ ] **Step 6: Run test and typecheck**

Run:

```bash
pnpm test src/lib/watermarkSvg.test.ts
pnpm build
```

Expected: tests still fail because `buildWatermarkSvg` is missing. Build should not fail from missing API methods.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/store/types.ts src/store/slices/watermark.ts src/lib/watermarkSvg.test.ts
git commit -m "feat: extend watermark svg settings types"
```

---

### Task 3: Implement TypeScript SVG Builder

**Files:**
- Create: `src/lib/watermarkSvg.ts`
- Modify: `src/lib/watermarkSvg.test.ts`

- [ ] **Step 1: Add tests for escaping, positioning, and SVG overrides**

Extend `src/lib/watermarkSvg.test.ts`:

```ts
it("escapes text and positions bottom-center watermarks", () => {
  const svg = buildWatermarkSvg(
    {
      ...DEFAULT_WATERMARK,
      enabled: true,
      kind: "text",
      text: '<Fuji & "Sim">',
      position: "bottom-center",
      fontSize: 24,
    },
    1000,
    500,
  );

  expect(svg).toContain("&lt;Fuji &amp; &quot;Sim&quot;&gt;");
  expect(svg).toContain('text-anchor="middle"');
  expect(svg).toContain('y="484"');
});

it("overrides imported svg fill, stroke, and text", () => {
  const svg = buildWatermarkSvg(
    {
      ...DEFAULT_WATERMARK,
      enabled: true,
      kind: "svg",
      source: "imported",
      svgMarkup:
        '<svg viewBox="0 0 20 10"><path fill="currentColor" stroke="#111" d="M0 0h20v10H0z"/><text>Old</text></svg>',
      svgFillOverride: "#abcdef",
      svgStrokeOverride: "#123456",
      svgTextOverride: "New",
    },
    200,
    100,
  );

  expect(svg).toContain('fill="#abcdef"');
  expect(svg).toContain('stroke="#123456"');
  expect(svg).toContain(">New<");
  expect(svg).not.toContain(">Old<");
});
```

- [ ] **Step 2: Run test and verify red**

Run:

```bash
pnpm test src/lib/watermarkSvg.test.ts
```

Expected: FAIL because implementation is missing.

- [ ] **Step 3: Create `src/lib/watermarkSvg.ts`**

Implement these exported functions:

```ts
import type { WatermarkPosition, WatermarkSettings } from "@/types";

const PADDING = 16;

export function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function anchor(position: WatermarkPosition, width: number, height: number) {
  const pad = PADDING;
  switch (position) {
    case "top-left": return { x: pad, y: pad, textAnchor: "start", dominantBaseline: "hanging" };
    case "top-center": return { x: width / 2, y: pad, textAnchor: "middle", dominantBaseline: "hanging" };
    case "top-right": return { x: width - pad, y: pad, textAnchor: "end", dominantBaseline: "hanging" };
    case "left-center": return { x: pad, y: height / 2, textAnchor: "start", dominantBaseline: "middle" };
    case "right-center": return { x: width - pad, y: height / 2, textAnchor: "end", dominantBaseline: "middle" };
    case "center": return { x: width / 2, y: height / 2, textAnchor: "middle", dominantBaseline: "middle" };
    case "bottom-left": return { x: pad, y: height - pad, textAnchor: "start", dominantBaseline: "auto" };
    case "bottom-right": return { x: width - pad, y: height - pad, textAnchor: "end", dominantBaseline: "auto" };
    case "bottom-center":
    default: return { x: width / 2, y: height - pad, textAnchor: "middle", dominantBaseline: "auto" };
  }
}

function transformFor(wm: WatermarkSettings, x: number, y: number): string {
  const sx = wm.flipH ? -wm.scale : wm.scale;
  const sy = wm.flipV ? -wm.scale : wm.scale;
  return `translate(${x + wm.offsetX} ${y + wm.offsetY}) rotate(${wm.rotation}) scale(${sx} ${sy})`;
}

function overrideImportedSvg(svg: string, wm: WatermarkSettings): string {
  let next = svg;
  if (wm.svgTextOverride !== undefined) {
    next = next.replace(/<text([^>]*)>[\s\S]*?<\/text>/gi, `<text$1>${escapeXml(wm.svgTextOverride)}</text>`);
  }
  if (wm.svgFillOverride) {
    next = next.replace(/\sfill=(["'])(?!none\b)[^"']*\1/gi, ` fill="${wm.svgFillOverride}"`);
    next = next.replace(/currentColor/g, wm.svgFillOverride);
  }
  if (wm.svgStrokeOverride) {
    next = next.replace(/\sstroke=(["'])(?!none\b)[^"']*\1/gi, ` stroke="${wm.svgStrokeOverride}"`);
  }
  return next.replace(/^<svg\b/i, "<g").replace(/<\/svg>\s*$/i, "</g>");
}

export function buildWatermarkSvg(wm: WatermarkSettings, width: number, height: number): string {
  const pos = anchor(wm.position, width, height);
  const x = pos.x;
  const y = pos.y;
  const transform = transformFor(wm, x, y);
  const opacity = Math.max(0, Math.min(1, wm.opacity));

  const body =
    wm.kind === "svg" && wm.svgMarkup
      ? overrideImportedSvg(wm.svgMarkup, wm)
      : `<text x="0" y="0" text-anchor="${pos.textAnchor}" dominant-baseline="${pos.dominantBaseline}" font-family="${escapeXml(wm.fontFamily)}" font-size="${wm.fontSize}" font-weight="${wm.bold ? 700 : 400}" font-style="${wm.italic ? "italic" : "normal"}" fill="${wm.color}">${escapeXml(wm.text)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g opacity="${opacity}" transform="${transform}">${body}</g></svg>`;
}
```

- [ ] **Step 4: Run tests and verify green**

Run:

```bash
pnpm test src/lib/watermarkSvg.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor if needed and rerun**

Run:

```bash
pnpm test src/lib/watermarkSvg.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/watermarkSvg.ts src/lib/watermarkSvg.test.ts
git commit -m "feat: build svg watermark markup"
```

---

### Task 4: Add SVG Watermark API Surface

**Files:**
- Modify: `src/api.ts`
- Modify: `src/main.tsx`
- Modify: `src/store/slices/watermark.ts`

- [ ] **Step 1: Add failing typecheck expectation**

Run:

```bash
pnpm build
```

Expected: FAIL because `api.listWatermarkSvgs`, `api.importWatermarkSvgs`, and `api.deleteWatermarkSvg` are missing.

- [ ] **Step 2: Update `src/api.ts`**

Import `UserWatermarkSvg` from `src/types.ts`, then add:

```ts
importWatermarkSvgs: (paths: string[]) =>
  invoke<UserWatermarkSvg[]>("import_watermark_svgs", { paths }),
listWatermarkSvgs: () =>
  invoke<UserWatermarkSvg[]>("list_watermark_svgs"),
deleteWatermarkSvg: (id: number) =>
  invoke<void>("delete_watermark_svg", { id }),
```

Change `startBatchExport` request type to remove `per_asset_watermark`.

Change `retryExportTask` to:

```ts
retryExportTask: (taskId: number) =>
  invoke<void>("retry_export_task", { taskId }),
```

- [ ] **Step 3: Replace temporary store actions with API-backed actions**

Replace the temporary no-op SVG actions in `src/store/slices/watermark.ts`:

```ts
refreshUserWatermarkSvgs: async () => {
  const svgs = await api.listWatermarkSvgs().catch(() => []);
  set({ userWatermarkSvgs: svgs });
},
importWatermarkSvgs: async (paths) => {
  const imported = await api.importWatermarkSvgs(paths);
  set({ userWatermarkSvgs: [...get().userWatermarkSvgs, ...imported] });
  return imported;
},
removeUserWatermarkSvg: async (id) => {
  await api.deleteWatermarkSvg(id);
  set({ userWatermarkSvgs: get().userWatermarkSvgs.filter((s) => s.id !== id) });
},
```

- [ ] **Step 4: Load imported SVGs at startup**

In `src/main.tsx`, after watermark presets refresh:

```ts
useStore.getState().refreshUserWatermarkSvgs();
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
pnpm build
```

Expected: Still may fail from backend IPC shape references not yet updated in Rust, but no front-end missing API method errors.

- [ ] **Step 6: Commit**

```bash
git add src/api.ts src/main.tsx src/store/slices/watermark.ts
git commit -m "feat: add imported watermark svg api"
```

---

### Task 5: Switch Preview Overlay to SVG

**Files:**
- Modify: `src/components/preview/WatermarkOverlay.tsx`
- Modify: `src/components/PreviewPanel.tsx`

- [ ] **Step 1: Add a failing test for data URL encoding**

Add to `src/lib/watermarkSvg.test.ts`:

```ts
import { svgToDataUrl } from "@/lib/watermarkSvg";

it("encodes svg as a data url", () => {
  expect(svgToDataUrl('<svg width="1" height="1"></svg>')).toMatch(/^data:image\/svg\+xml,/);
});
```

- [ ] **Step 2: Run test and verify red**

Run:

```bash
pnpm test src/lib/watermarkSvg.test.ts
```

Expected: FAIL because `svgToDataUrl` is missing.

- [ ] **Step 3: Implement `svgToDataUrl`**

Add to `src/lib/watermarkSvg.ts`:

```ts
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
```

- [ ] **Step 4: Replace Canvas overlay**

Update `WatermarkOverlay.tsx`:

```tsx
import { useMemo } from "react";
import type { WatermarkSettings } from "@/types";
import { buildWatermarkSvg, svgToDataUrl } from "@/lib/watermarkSvg";

export function WatermarkOverlay({ wm, imgW, imgH }: { wm: WatermarkSettings; imgW: number; imgH: number }) {
  const dataUrl = useMemo(() => svgToDataUrl(buildWatermarkSvg(wm, imgW, imgH)), [wm, imgW, imgH]);
  return (
    <img
      src={dataUrl}
      alt=""
      style={{ position: "absolute", top: 0, left: 0, width: imgW, height: imgH, pointerEvents: "none" }}
    />
  );
}
```

`PreviewPanel.tsx` should not need structural changes beyond type compatibility.

- [ ] **Step 5: Run tests and build**

Run:

```bash
pnpm test src/lib/watermarkSvg.test.ts
pnpm build
```

Expected: Tests PASS. Build may still fail on export/backend API changes scheduled later; no overlay-related errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/watermarkSvg.ts src/lib/watermarkSvg.test.ts src/components/preview/WatermarkOverlay.tsx src/components/PreviewPanel.tsx
git commit -m "feat: render watermark preview as svg"
```

---

### Task 6: Remove Front-End PNG Export Payload

**Files:**
- Modify: `src/components/ExportDialog.tsx`
- Modify: `src/store/slices/exports.ts`
- Modify: `src/api.ts`

- [ ] **Step 1: Run typecheck to capture current PNG references**

Run:

```bash
pnpm build
```

Expected: FAIL or show references to `per_asset_watermark`, `renderWatermarkLayer`, or retry `watermarkLayer`.

- [ ] **Step 2: Remove PNG rendering from `ExportDialog.tsx`**

Delete:

```ts
import { renderWatermarkLayer } from "@/lib/watermarkCanvas";
```

Delete the `resolveDims` helper and the `perAssetWatermark` loop.

Change `api.startBatchExport` call to:

```ts
await api.startBatchExport({
  asset_ids: targetIds,
  filter,
  export: settings,
  watermark_settings: watermark.enabled ? watermark : null,
});
```

- [ ] **Step 3: Update retry caller**

In `src/store/slices/exports.ts`, replace retry calls:

```ts
await api.retryExportTask(taskId);
```

Remove any code that tries to regenerate or pass a watermark layer.

- [ ] **Step 4: Run search and typecheck**

Run:

```bash
rg -n "renderWatermarkLayer|per_asset_watermark|watermarkLayer" src
pnpm build
```

Expected: `rg` returns no front-end PNG payload references. Build proceeds until backend command shape mismatches or unrelated errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/ExportDialog.tsx src/store/slices/exports.ts src/api.ts
git commit -m "feat: remove png watermark export payload"
```

---

### Task 7: Build Watermark Tab Recommended and Custom Lists

**Files:**
- Modify: `src/components/WatermarkTab.tsx`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh.ts`

- [ ] **Step 1: Add i18n keys**

Add to `src/i18n/en.ts` under `watermark`:

```ts
recommended: "Recommended",
custom: "Custom",
importSvg: "Import SVG",
svgFill: "Fill",
svgStroke: "Stroke",
svgText: "SVG text",
scale: "Scale",
```

Add to `src/i18n/zh.ts`:

```ts
recommended: "推荐",
custom: "自定义",
importSvg: "导入 SVG",
svgFill: "填充",
svgStroke: "描边",
svgText: "SVG 文字",
scale: "缩放",
```

- [ ] **Step 2: Replace preset select with card sections**

In `WatermarkTab.tsx`, remove the style preset `<Select>` block and replace it with:

```tsx
<WatermarkCardSection title={t("watermark.recommended")}>
  {presetStyles.map((p) => (
    <WatermarkStyleCard
      key={p.label}
      label={p.label}
      wm={{ ...wm, enabled: true, kind: "text", source: "builtin", text: p.text, fontSize: p.fontSize, color: p.color, opacity: p.opacity, italic: p.italic, position: p.position, offsetX: 0, offsetY: 0 }}
      onClick={() => { applyPreset(p); setSelectedId(null); }}
    />
  ))}
</WatermarkCardSection>
```

- [ ] **Step 3: Add import SVG action**

Add:

```ts
const userWatermarkSvgs = useStore((s) => s.userWatermarkSvgs);
const importWatermarkSvgs = useStore((s) => s.importWatermarkSvgs);
const removeUserWatermarkSvg = useStore((s) => s.removeUserWatermarkSvg);
const applyImportedWatermarkSvg = useStore((s) => s.applyImportedWatermarkSvg);

async function importSvg() {
  const selected = await openDialog({ multiple: true, filters: [{ name: "SVG", extensions: ["svg"] }] });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  const imported = await importWatermarkSvgs(paths);
  if (imported[0]) applyImportedWatermarkSvg(imported[0]);
}
```

- [ ] **Step 4: Add custom cards**

Render imported SVGs and saved presets:

```tsx
<WatermarkCardSection title={t("watermark.custom")} actionLabel={t("watermark.importSvg")} onAction={importSvg}>
  {userWatermarkSvgs.map((item) => (
    <WatermarkStyleCard
      key={`svg-${item.id}`}
      label={item.name}
      wm={{ ...wm, enabled: true, kind: "svg", source: "imported", svgId: item.id, svgMarkup: item.preview_svg ?? "" }}
      onClick={() => applyImportedWatermarkSvg(item)}
      onDelete={() => removeUserWatermarkSvg(item.id)}
    />
  ))}
  {watermarkPresets.map((preset) => (
    <WatermarkPresetCard
      key={`preset-${preset.id}`}
      preset={preset}
      onClick={() => applyWatermarkPreset(preset)}
      onDelete={() => removeWatermarkPreset(preset.id)}
    />
  ))}
</WatermarkCardSection>
```

- [ ] **Step 5: Add small helper components**

At the bottom of the file add:

```tsx
function WatermarkCardSection({ title, actionLabel, onAction, children }: { title: string; actionLabel?: string; onAction?: () => void; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <Label>{title}</Label>
        {actionLabel && <button type="button" onClick={onAction} className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-200">{actionLabel}</button>}
      </div>
      <div className="grid grid-cols-2 gap-2">{children}</div>
    </div>
  );
}

function WatermarkStyleCard({ label, wm, onClick, onDelete }: { label: string; wm: WatermarkSettings; onClick: () => void; onDelete?: () => void }) {
  const preview = svgToDataUrl(buildWatermarkSvg(wm, 220, 120));
  return (
    <button type="button" onClick={onClick} className="relative h-24 rounded border border-zinc-800 bg-zinc-950 hover:border-zinc-600 overflow-hidden text-left">
      <img src={preview} alt="" className="h-16 w-full object-contain bg-zinc-900" />
      <span className="block px-2 py-1 text-[11px] text-zinc-300 truncate">{label}</span>
      {onDelete && <span onClick={(e) => { e.stopPropagation(); onDelete(); }} className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-zinc-950/80 text-zinc-500 hover:text-red-400"><Trash2 size={11} /></span>}
    </button>
  );
}
```

Import `WatermarkSettings`, `buildWatermarkSvg`, and `svgToDataUrl`.

- [ ] **Step 6: Add SVG-specific controls**

Show for `wm.kind === "svg"`:

```tsx
{wm.kind === "svg" && (
  <div className="space-y-3">
    <div>
      <Label>{t("watermark.svgText")}</Label>
      <Input value={wm.svgTextOverride ?? ""} onChange={(e) => setWatermark({ svgTextOverride: e.target.value })} className="h-7 text-xs" />
    </div>
    <ColorRow label={t("watermark.svgFill")} value={wm.svgFillOverride ?? wm.color} onChange={(v) => setWatermark({ svgFillOverride: v })} />
    <ColorRow label={t("watermark.svgStroke")} value={wm.svgStrokeOverride ?? wm.strokeColor} onChange={(v) => setWatermark({ svgStrokeOverride: v })} />
  </div>
)}
```

Use the existing color input pattern if `ColorRow` does not exist.

- [ ] **Step 7: Run build**

Run:

```bash
pnpm build
```

Expected: No WatermarkTab TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/WatermarkTab.tsx src/i18n/en.ts src/i18n/zh.ts
git commit -m "feat: add svg watermark lists"
```

---

### Task 8: Add Rust Imported SVG Database and IPC

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/db/mod.rs`
- Create: `src-tauri/src/db/watermark_svgs.rs`
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/ipc/watermark.rs`
- Modify: `src-tauri/src/ipc/mod.rs`
- Modify: `src-tauri/src/ipc/app.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add failing Rust tests for SVG sanitizer**

Create `src-tauri/src/export/watermark_svg.rs` with only tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_removes_scripts_and_event_handlers() {
        let input = r#"<svg viewBox="0 0 10 10"><script>alert(1)</script><path onclick="x()" fill="red" d="M0 0h10v10H0z"/></svg>"#;
        let out = sanitize_svg(input).unwrap();
        assert!(!out.contains("<script"));
        assert!(!out.contains("onclick"));
        assert!(out.contains("viewBox"));
    }

    #[test]
    fn sanitize_requires_svg_root() {
        assert!(sanitize_svg("<div></div>").is_err());
    }
}
```

Add `pub mod watermark_svg;` in `src-tauri/src/export/mod.rs`.

- [ ] **Step 2: Run test and verify red**

Run:

```bash
cargo test -p fujisim watermark_svg
```

Expected: FAIL because `sanitize_svg` does not exist.

- [ ] **Step 3: Add `watermark_svg_dir`**

In `src-tauri/src/state.rs`, add:

```rust
pub watermark_svg_dir: PathBuf,
```

Initialize:

```rust
let watermark_svg_dir = data_dir.join("watermark_svgs");
std::fs::create_dir_all(&watermark_svg_dir)?;
```

Add field to `SharedState` construction.

- [ ] **Step 4: Add DB table and module**

In `src-tauri/src/db/mod.rs`, add:

```rust
pub mod watermark_svgs;
```

Add schema:

```sql
CREATE TABLE IF NOT EXISTS user_watermark_svgs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    preview_svg TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);
```

- [ ] **Step 5: Create `src-tauri/src/db/watermark_svgs.rs`**

Implement:

```rust
use crate::error::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserWatermarkSvg {
    pub id: i64,
    pub name: String,
    pub file_path: String,
    pub preview_svg: Option<String>,
    pub created_at: String,
    pub is_deleted: i64,
    pub deleted_at: Option<String>,
}

pub async fn insert(pool: &SqlitePool, name: &str, file_path: &str, preview_svg: Option<&str>) -> Result<UserWatermarkSvg> {
    sqlx::query(
        r#"INSERT INTO user_watermark_svgs (name, file_path, preview_svg) VALUES (?, ?, ?)
           ON CONFLICT(file_path) DO UPDATE SET name = excluded.name, preview_svg = excluded.preview_svg, is_deleted = 0, deleted_at = NULL"#,
    )
    .bind(name)
    .bind(file_path)
    .bind(preview_svg)
    .execute(pool)
    .await?;
    sqlx::query_as::<_, UserWatermarkSvg>("SELECT * FROM user_watermark_svgs WHERE file_path = ?")
        .bind(file_path)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<UserWatermarkSvg>> {
    sqlx::query_as::<_, UserWatermarkSvg>("SELECT * FROM user_watermark_svgs WHERE is_deleted = 0 ORDER BY name ASC")
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT file_path FROM user_watermark_svgs WHERE id = ? AND is_deleted = 0")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    sqlx::query("UPDATE user_watermark_svgs SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(row.map(|(p,)| p))
}

pub async fn delete_all(pool: &SqlitePool) -> Result<()> {
    sqlx::query("UPDATE user_watermark_svgs SET is_deleted = 1, deleted_at = datetime('now') WHERE is_deleted = 0")
        .execute(pool)
        .await?;
    Ok(())
}
```

- [ ] **Step 6: Implement sanitizer enough for tests**

In `src-tauri/src/export/watermark_svg.rs`:

```rust
use crate::error::{AppError, Result};

pub fn sanitize_svg(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if !trimmed.to_ascii_lowercase().starts_with("<svg") {
        return Err(AppError::other("svg root required"));
    }
    let mut out = trimmed.to_string();
    for tag in ["script", "foreignObject", "animate", "set"] {
        let pattern = regex::Regex::new(&format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}>")).unwrap();
        out = pattern.replace_all(&out, "").into_owned();
    }
    let event_attr = regex::Regex::new(r#"(?i)\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*')"#).unwrap();
    out = event_attr.replace_all(&out, "").into_owned();
    let remote_href = regex::Regex::new(r#"(?i)\s+(href|xlink:href)\s*=\s*["']https?://[^"']*["']"#).unwrap();
    out = remote_href.replace_all(&out, "").into_owned();
    Ok(out)
}
```

Add `regex = "1"` to `src-tauri/Cargo.toml`.

- [ ] **Step 7: Add IPC commands**

In `src-tauri/src/ipc/watermark.rs`, add:

```rust
use crate::db::watermark_svgs;
use crate::export::watermark_svg::sanitize_svg;
use std::path::{Path, PathBuf};

#[tauri::command]
pub async fn list_watermark_svgs(state: State<'_, SharedState>) -> Result<Vec<watermark_svgs::UserWatermarkSvg>> {
    watermark_svgs::list(&state.pool).await
}

#[tauri::command]
pub async fn import_watermark_svgs(state: State<'_, SharedState>, paths: Vec<String>) -> Result<Vec<watermark_svgs::UserWatermarkSvg>> {
    let mut out = Vec::new();
    for src in paths {
        let src_path = PathBuf::from(&src);
        if src_path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("svg")) != Some(true) {
            continue;
        }
        let raw = std::fs::read_to_string(&src_path)?;
        let sanitized = sanitize_svg(&raw)?;
        let stem = src_path.file_stem().and_then(|s| s.to_str()).unwrap_or("watermark");
        let dest = state.watermark_svg_dir.join(format!("{stem}.svg"));
        std::fs::write(&dest, &sanitized)?;
        let dest_str = dest.to_string_lossy().to_string();
        out.push(watermark_svgs::insert(&state.pool, stem, &dest_str, Some(&sanitized)).await?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn delete_watermark_svg(state: State<'_, SharedState>, id: i64) -> Result<()> {
    if let Some(path) = watermark_svgs::delete(&state.pool, id).await? {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}
```

- [ ] **Step 8: Register commands and clear data**

In `src-tauri/src/lib.rs`, register:

```rust
ipc::list_watermark_svgs,
ipc::import_watermark_svgs,
ipc::delete_watermark_svg,
```

In `src-tauri/src/ipc/app.rs`, call `watermark_svgs::delete_all` and clear `state.watermark_svg_dir`.

- [ ] **Step 9: Run Rust tests**

Run:

```bash
cargo test -p fujisim watermark_svg
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/state.rs src-tauri/src/db/mod.rs src-tauri/src/db/watermark_svgs.rs src-tauri/src/ipc/watermark.rs src-tauri/src/ipc/app.rs src-tauri/src/lib.rs src-tauri/src/export/watermark_svg.rs
git commit -m "feat: import watermark svg assets"
```

---

### Task 9: Add Rust SVG Watermark Rendering

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/export/watermark_svg.rs`
- Modify: `src-tauri/src/export/mod.rs`

- [ ] **Step 1: Add failing render test**

Add to `src-tauri/src/export/watermark_svg.rs` tests:

```rust
#[test]
fn render_svg_watermark_outputs_rgba_pixels() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10"><rect width="20" height="10" fill="#ffffff"/></svg>"##;
    let img = rasterize_svg(svg, 20, 10).unwrap();
    assert_eq!(img.width(), 20);
    assert_eq!(img.height(), 10);
    assert!(img.pixels().any(|p| p[3] > 0));
}
```

- [ ] **Step 2: Run and verify red**

Run:

```bash
cargo test -p fujisim render_svg_watermark_outputs_rgba_pixels
```

Expected: FAIL because `rasterize_svg` is missing.

- [ ] **Step 3: Add dependencies**

In `src-tauri/Cargo.toml`:

```toml
resvg = "0.45"
usvg = "0.45"
tiny-skia = "0.11"
```

- [ ] **Step 4: Implement `rasterize_svg`**

Add:

```rust
use image::RgbaImage;

pub fn rasterize_svg(svg: &str, out_w: u32, out_h: u32) -> Result<RgbaImage> {
    let opt = usvg::Options::default();
    let tree = usvg::Tree::from_str(svg, &opt)
        .map_err(|e| AppError::other(format!("svg parse: {e}")))?;
    let mut pixmap = tiny_skia::Pixmap::new(out_w, out_h)
        .ok_or_else(|| AppError::other("svg pixmap allocation failed"))?;
    let size = tree.size();
    let sx = out_w as f32 / size.width();
    let sy = out_h as f32 / size.height();
    let transform = tiny_skia::Transform::from_scale(sx, sy);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    let data = pixmap.take();
    RgbaImage::from_raw(out_w, out_h, data)
        .ok_or_else(|| AppError::other("svg rgba buffer mismatch"))
}
```

Adjust function signatures if the selected crate version differs; keep behavior identical.

- [ ] **Step 5: Run test**

Run:

```bash
cargo test -p fujisim render_svg_watermark_outputs_rgba_pixels
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml Cargo.lock src-tauri/src/export/watermark_svg.rs
git commit -m "feat: rasterize svg watermarks"
```

---

### Task 10: Wire SVG Watermark into Export

**Files:**
- Modify: `src-tauri/src/export/mod.rs`
- Modify: `src-tauri/src/ipc/export.rs`
- Modify: `src-tauri/src/db/tasks.rs`

- [ ] **Step 1: Add failing export model test**

Add to `src-tauri/src/export/watermark_svg.rs`:

```rust
#[test]
fn build_text_watermark_svg_uses_output_size() {
    let settings = serde_json::json!({
        "enabled": true,
        "kind": "text",
        "source": "builtin",
        "text": "FujiSim",
        "fontSize": 32,
        "fontFamily": "Arial, sans-serif",
        "color": "#ffffff",
        "opacity": 0.7,
        "position": "bottom-center",
        "offsetX": 0,
        "offsetY": 0,
        "scale": 1,
        "rotation": 0,
        "flipH": false,
        "flipV": false
    });
    let svg = build_watermark_svg_from_json(&settings, 600, 400).unwrap();
    assert!(svg.contains(r#"width="600""#));
    assert!(svg.contains("FujiSim"));
}
```

- [ ] **Step 2: Run red**

Run:

```bash
cargo test -p fujisim build_text_watermark_svg_uses_output_size
```

Expected: FAIL because builder is missing.

- [ ] **Step 3: Implement JSON-to-SVG builder**

In `watermark_svg.rs`, add serde structs with optional defaults matching front-end fields, plus:

```rust
pub fn build_watermark_svg_from_json(settings: &serde_json::Value, out_w: u32, out_h: u32) -> Result<String> {
    let text = settings.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let color = settings.get("color").and_then(|v| v.as_str()).unwrap_or("#ffffff");
    let opacity = settings.get("opacity").and_then(|v| v.as_f64()).unwrap_or(1.0).clamp(0.0, 1.0);
    let font_size = settings.get("fontSize").and_then(|v| v.as_f64()).unwrap_or(32.0);
    let x = out_w as f64 / 2.0;
    let y = out_h as f64 - 16.0;
    Ok(format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{out_w}" height="{out_h}" viewBox="0 0 {out_w} {out_h}"><g opacity="{opacity}"><text x="{x}" y="{y}" text-anchor="middle" font-size="{font_size}" fill="{color}">{}</text></g></svg>"#,
        xml_escape(text)
    ))
}
```

Include a small `xml_escape` helper. This is the minimum green implementation; later refactor can align all positioning variants.

- [ ] **Step 4: Change export function signature**

In `src-tauri/src/export/mod.rs`, change:

```rust
watermark_path: Option<&Path>,
```

to:

```rust
watermark_settings: Option<&serde_json::Value>,
```

In the watermark composite block:

```rust
let final_image = if let Some(wm) = watermark_settings {
    match crate::export::watermark_svg::build_watermark_svg_from_json(wm, out_w, out_h)
        .and_then(|svg| crate::export::watermark_svg::rasterize_svg(&svg, out_w, out_h))
    {
        Ok(overlay) => {
            let mut rgb8 = to_rgb8(&final_image);
            composite_watermark(&mut rgb8, &overlay);
            // existing rgb8 -> rgb16 conversion
        }
        Err(e) => {
            tracing::warn!("svg watermark composite skipped: {e}");
            final_image
        }
    }
} else {
    final_image
};
```

- [ ] **Step 5: Update `ipc/export.rs`**

Remove `PerAssetWatermark`, `per_asset_watermark`, `save_watermark_layer`, and retry `watermark_layer`.

When dispatching a task, parse:

```rust
let watermark_settings: Option<serde_json::Value> =
    task.watermark_json.as_deref().and_then(|s| serde_json::from_str(s).ok());
```

Pass `watermark_settings.as_ref()` to `export_one`.

- [ ] **Step 6: Run Rust tests and check**

Run:

```bash
cargo test -p fujisim watermark_svg
cargo check -p fujisim
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/export/mod.rs src-tauri/src/export/watermark_svg.rs src-tauri/src/ipc/export.rs src-tauri/src/db/tasks.rs
git commit -m "feat: export svg watermarks from settings"
```

---

### Task 11: Remove Obsolete PNG Watermark Code

**Files:**
- Delete or stop using: `src/lib/watermarkCanvas.ts`
- Modify: `src-tauri/src/vips_io.rs`
- Modify: `src-tauri/src/export/mod.rs`
- Modify: `src-tauri/src/ipc/export.rs`
- Modify: `src/api.ts`

- [ ] **Step 1: Search obsolete references**

Run:

```bash
rg -n "WatermarkLayer|watermark_layer|watermarkLayer|per_asset_watermark|renderWatermarkLayer|load_watermark|save_watermark_layer" src src-tauri
```

Expected: Finds obsolete references to remove.

- [ ] **Step 2: Delete front-end canvas helper if unused**

If the previous search only finds `src/lib/watermarkCanvas.ts`, delete that file.

- [ ] **Step 3: Remove Rust PNG loader if unused**

In `src-tauri/src/vips_io.rs`, remove `load_watermark()` if it has no callers.

In `src-tauri/src/export/mod.rs`, remove old `WatermarkLayer` struct if it has no callers.

- [ ] **Step 4: Keep DB field but stop writing**

Do not remove `batch_tasks.watermark_layer_path` from DB schema in this task. It remains for old rows and future migration cleanup.

- [ ] **Step 5: Verify no obsolete references**

Run:

```bash
rg -n "WatermarkLayer|watermarkLayer|per_asset_watermark|renderWatermarkLayer|load_watermark|save_watermark_layer" src src-tauri
```

Expected: No results.

- [ ] **Step 6: Run full checks**

Run:

```bash
pnpm build
cargo check -p fujisim
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src src-tauri
git commit -m "refactor: remove png watermark pipeline"
```

---

### Task 12: Final Verification

**Files:**
- No planned edits unless verification exposes a defect.

- [ ] **Step 1: Run front-end unit tests**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 2: Run front-end build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 3: Run Rust tests**

Run:

```bash
cargo test -p fujisim
```

Expected: PASS.

- [ ] **Step 4: Run Rust check**

Run:

```bash
cargo check -p fujisim
```

Expected: PASS.

- [ ] **Step 5: Manual app smoke test**

Run:

```bash
pnpm tauri dev
```

Verify:

- Watermark Tab shows recommended cards with SVG thumbnails.
- Importing an SVG adds it to Custom.
- Fill/stroke override changes preview.
- Text override changes imported SVG text when `<text>` exists.
- Export with text watermark succeeds.
- Export with imported SVG watermark succeeds.
- Retrying a failed/cancelled export does not ask the front-end for a PNG layer.

- [ ] **Step 6: Commit fixes or final marker**

If verification required fixes:

```bash
git add <changed-files>
git commit -m "fix: stabilize svg watermark verification"
```

If no fixes were needed, do not create an empty commit.

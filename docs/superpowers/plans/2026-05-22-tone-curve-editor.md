# Tone Curve Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Lightroom-style point curve editor (RGB + R/G/B channels) to FujiSim, wired end-to-end from SVG UI to Rust image pipeline.

**Architecture:** Frontend sends `ToneCurvePoints` (control point arrays) as part of `FilterSettings` via existing IPC; Rust uses the `splines` crate to interpolate control points into a 256-entry LUT, then applies it as step `[2b]` in the existing `process_image` pipeline after the Fuji preset curves.

**Tech Stack:** React 18 + SVG (no new frontend deps), Rust `splines = "5.0.0"`, existing Tauri IPC / Zustand store.

---

### Task 1: Data types — frontend

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add `CurvePoint` and `ToneCurvePoints` types, extend `FilterSettings`**

In `src/types.ts`, after the `FilterSettings` type definition (line 72–85), add:

```typescript
export type CurvePoint = { x: number; y: number };

export type ToneCurvePoints = {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
};
```

Then add `tone_curve?: ToneCurvePoints | null;` as the last field of `FilterSettings`:

```typescript
export type FilterSettings = {
  base_simulation: string;
  grain_effect?: string | null;
  grain_size?: string | null;
  color_chrome_effect?: string | null;
  highlight_tone: number;
  shadow_tone: number;
  color_saturation: number;
  clarity: number;
  sharpness: number;
  wb_shift_r: number;
  wb_shift_b: number;
  lut_file_path?: string | null;
  tone_curve?: ToneCurvePoints | null;
};
```

- [ ] **Step 2: Update `DEFAULT_FILTER` in `src/store.ts`**

In `src/store.ts` at line 41–54, add `tone_curve: null` to `DEFAULT_FILTER`:

```typescript
export const DEFAULT_FILTER: FilterSettings = {
  base_simulation: "Pass-Through",
  grain_effect: "None",
  grain_size: "Small",
  color_chrome_effect: "None",
  highlight_tone: 0,
  shadow_tone: 0,
  color_saturation: 0,
  clarity: 0,
  sharpness: 0,
  wb_shift_r: 0,
  wb_shift_b: 0,
  lut_file_path: null,
  tone_curve: null,
};
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/ry2019/private/FujiSim && npm run build 2>&1 | tail -20
```

Expected: no TypeScript errors (build may fail on Rust side, that's fine for now).

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/store.ts
git commit -m "feat: add CurvePoint/ToneCurvePoints types and extend FilterSettings"
```

---

### Task 2: Rust data types + splines dependency

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/processing/pipeline.rs`

- [ ] **Step 1: Add `splines` to Cargo.toml**

In `src-tauri/Cargo.toml`, after the `rand = "0.8"` line, add:

```toml
splines = "5.0.0"
```

- [ ] **Step 2: Add `CurvePoint`, `ToneCurvePoints` structs to `pipeline.rs`**

In `src-tauri/src/processing/pipeline.rs`, after the `use` block (after line 12), add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurvePoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ToneCurvePoints {
    pub rgb: Vec<CurvePoint>,
    pub r: Vec<CurvePoint>,
    pub g: Vec<CurvePoint>,
    pub b: Vec<CurvePoint>,
}
```

- [ ] **Step 3: Add `tone_curve` field to `FilterSettings` struct**

In `src-tauri/src/processing/pipeline.rs`, add to the `FilterSettings` struct after `wb_shift_b`:

```rust
#[serde(default)]
pub tone_curve: Option<ToneCurvePoints>,
```

- [ ] **Step 4: Update `is_identity()` to account for tone_curve**

In `src-tauri/src/processing/pipeline.rs`, in the `is_identity()` method, add the following condition at the end of the `&&`-chain:

```rust
&& self.tone_curve.as_ref().map_or(true, |tc| {
    tc.rgb.is_empty() && tc.r.is_empty() && tc.g.is_empty() && tc.b.is_empty()
})
```

- [ ] **Step 5: Update `Default` impl for `FilterSettings`**

In `src-tauri/src/processing/pipeline.rs`, in the `Default` impl, add:

```rust
tone_curve: None,
```

- [ ] **Step 6: Verify Rust compiles**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo check 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/processing/pipeline.rs
git commit -m "feat: add CurvePoint/ToneCurvePoints to Rust pipeline, add splines dep"
```

---

### Task 3: `ToneCurve::from_points` in Rust

**Files:**
- Modify: `src-tauri/src/processing/curves.rs`

- [ ] **Step 1: Add `splines` import and `from_points` method**

In `src-tauri/src/processing/curves.rs`, add the import at the top:

```rust
use splines::{Interpolation, Key, Spline};
use crate::processing::pipeline::CurvePoint;
```

Then add the `from_points` method inside the `impl ToneCurve` block, after the existing `apply` method:

```rust
/// Build a ToneCurve LUT from user-supplied control points using CatmullRom spline.
/// Points are sorted by x. If fewer than 2 points, returns identity.
/// Ghost points are added at both ends to ensure smooth interpolation at boundaries.
pub fn from_points(points: &[CurvePoint]) -> Self {
    if points.len() < 2 {
        return Self::identity();
    }

    // Sort by x ascending
    let mut sorted = points.to_vec();
    sorted.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));

    // Build spline keys; add ghost points at both ends for CatmullRom boundary stability
    let first = &sorted[0];
    let last = &sorted[sorted.len() - 1];

    let mut keys: Vec<Key<f32, f32>> = Vec::with_capacity(sorted.len() + 2);
    // Ghost point before first (same y, slightly before x)
    keys.push(Key::new(first.x - 0.01, first.y, Interpolation::CatmullRom));
    for pt in &sorted {
        keys.push(Key::new(pt.x, pt.y, Interpolation::CatmullRom));
    }
    // Ghost point after last (same y, slightly after x)
    keys.push(Key::new(last.x + 0.01, last.y, Interpolation::CatmullRom));

    let spline = Spline::from_vec(keys);

    let mut lut = [0.0f32; 256];
    for (i, slot) in lut.iter_mut().enumerate() {
        let x = i as f32 / 255.0;
        let y = spline.clamped_sample(x).unwrap_or(x);
        *slot = y.clamp(0.0, 1.0);
    }
    ToneCurve { lut }
}
```

- [ ] **Step 2: Verify Rust compiles**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo check 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/processing/curves.rs
git commit -m "feat: add ToneCurve::from_points using splines CatmullRom"
```

---

### Task 4: Wire user curve into pipeline

**Files:**
- Modify: `src-tauri/src/processing/pipeline.rs`

- [ ] **Step 1: Build user curve LUTs before the pixel loop**

In `src-tauri/src/processing/pipeline.rs`, in `process_image`, after the line:

```rust
let (rc, gc, bc) =
    curves::build_per_channel_curves(&curve, profile.r_tilt, profile.g_tilt, profile.b_tilt);
```

Add:

```rust
// Pre-build user curve LUTs (once, before pixel loop)
let user_rgb_curve = settings.tone_curve.as_ref()
    .filter(|tc| !tc.rgb.is_empty())
    .map(|tc| ToneCurve::from_points(&tc.rgb));
let user_r_curve = settings.tone_curve.as_ref()
    .filter(|tc| !tc.r.is_empty())
    .map(|tc| ToneCurve::from_points(&tc.r));
let user_g_curve = settings.tone_curve.as_ref()
    .filter(|tc| !tc.g.is_empty())
    .map(|tc| ToneCurve::from_points(&tc.g));
let user_b_curve = settings.tone_curve.as_ref()
    .filter(|tc| !tc.b.is_empty())
    .map(|tc| ToneCurve::from_points(&tc.b));
```

- [ ] **Step 2: Apply user curves inside the pixel loop as step [2b]**

In `src-tauri/src/processing/pipeline.rs`, inside the `par_chunks_mut` closure, after the line:

```rust
b = bc.apply(b);
```

Add:

```rust
// [2b] User point curves (applied on top of Fuji preset curves)
if let Some(ref uc) = user_rgb_curve {
    r = uc.apply(r);
    g = uc.apply(g);
    b = uc.apply(b);
}
if let Some(ref uc) = user_r_curve { r = uc.apply(r); }
if let Some(ref uc) = user_g_curve { g = uc.apply(g); }
if let Some(ref uc) = user_b_curve { b = uc.apply(b); }
```

- [ ] **Step 3: Verify Rust compiles**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo check 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/processing/pipeline.rs
git commit -m "feat: apply user tone curve in pipeline step [2b]"
```

---

### Task 5: i18n strings

**Files:**
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 1: Add curve tab label to zh.ts**

In `src/i18n/zh.ts`, in the `filterPanel.tabs` object, add:

```typescript
curves: "曲线",
```

- [ ] **Step 2: Add curve tab label to en.ts**

In `src/i18n/en.ts`, in the `filterPanel.tabs` object, add:

```typescript
curves: "Curves",
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat: add curves tab i18n strings"
```

---

### Task 6: CurvesEditor component

**Files:**
- Create: `src/components/CurvesEditor.tsx`

- [ ] **Step 1: Create the component file**

Create `src/components/CurvesEditor.tsx` with the following content:

```tsx
import { useCallback, useRef, useState } from "react";
import type { CurvePoint, ToneCurvePoints } from "@/types";

type Channel = "rgb" | "r" | "g" | "b";

const CHANNEL_COLOR: Record<Channel, string> = {
  rgb: "#e4e4e7",
  r: "#f87171",
  g: "#4ade80",
  b: "#60a5fa",
};

const SIZE = 200;
const PAD = 12;
const INNER = SIZE - PAD * 2;

function toSvg(v: number) {
  return PAD + (1 - v) * INNER;
}
function fromSvg(px: number) {
  return 1 - (px - PAD) / INNER;
}
function toSvgX(v: number) {
  return PAD + v * INNER;
}
function fromSvgX(px: number) {
  return (px - PAD) / INNER;
}

function catmullRomPath(pts: CurvePoint[]): string {
  if (pts.length < 2) {
    return `M ${toSvgX(0)} ${toSvg(0)} L ${toSvgX(1)} ${toSvg(1)}`;
  }
  const sorted = [...pts].sort((a, b) => a.x - b.x);
  // Extend with ghost points for boundary smoothness
  const ext = [
    { x: sorted[0].x - 0.01, y: sorted[0].y },
    ...sorted,
    { x: sorted[sorted.length - 1].x + 0.01, y: sorted[sorted.length - 1].y },
  ];
  let d = `M ${toSvgX(sorted[0].x)} ${toSvg(sorted[0].y)}`;
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    const cp1x = toSvgX(p1.x + (p2.x - p0.x) / 6);
    const cp1y = toSvg(p1.y + (p2.y - p0.y) / 6);
    const cp2x = toSvgX(p2.x - (p3.x - p1.x) / 6);
    const cp2y = toSvg(p2.y - (p3.y - p1.y) / 6);
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${toSvgX(p2.x)} ${toSvg(p2.y)}`;
  }
  return d;
}

const DEFAULT_POINTS: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

function ensureEndpoints(pts: CurvePoint[]): CurvePoint[] {
  const sorted = [...pts].sort((a, b) => a.x - b.x);
  if (!sorted.find((p) => p.x === 0)) sorted.unshift({ x: 0, y: 0 });
  if (!sorted.find((p) => p.x === 1)) sorted.push({ x: 1, y: 1 });
  return sorted;
}

export function CurvesEditor({
  value,
  onChange,
}: {
  value: ToneCurvePoints | null | undefined;
  onChange: (v: ToneCurvePoints) => void;
}) {
  const [activeChannel, setActiveChannel] = useState<Channel>("rgb");
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const draggingIdx = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const curves: ToneCurvePoints = value ?? {
    rgb: [...DEFAULT_POINTS],
    r: [],
    g: [],
    b: [],
  };

  const activePoints: CurvePoint[] = (() => {
    const pts = curves[activeChannel];
    return pts.length === 0 ? [...DEFAULT_POINTS] : pts;
  })();

  function updateChannel(pts: CurvePoint[]) {
    const cleaned = ensureEndpoints(pts);
    // If it's just the two default endpoints, store as empty (identity)
    const isIdentity =
      cleaned.length === 2 &&
      cleaned[0].x === 0 && cleaned[0].y === 0 &&
      cleaned[1].x === 1 && cleaned[1].y === 1;
    onChange({
      ...curves,
      [activeChannel]: isIdentity ? [] : cleaned,
    });
  }

  function svgCoords(e: React.MouseEvent | MouseEvent): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const scaleX = SIZE / rect.width;
    const scaleY = SIZE / rect.height;
    return {
      x: Math.max(0, Math.min(1, fromSvgX(px * scaleX))),
      y: Math.max(0, Math.min(1, fromSvg(py * scaleY))),
    };
  }

  const handleSvgClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (draggingIdx.current !== null) return;
      const { x, y } = svgCoords(e);
      // Don't add if clicking near an existing point
      const near = activePoints.findIndex(
        (p) => Math.abs(p.x - x) < 0.04 && Math.abs(p.y - y) < 0.04
      );
      if (near !== -1) return;
      updateChannel([...activePoints, { x, y }]);
    },
    [activePoints, activeChannel, curves]
  );

  function handlePointMouseDown(e: React.MouseEvent, idx: number) {
    e.stopPropagation();
    draggingIdx.current = idx;

    function onMove(ev: MouseEvent) {
      if (draggingIdx.current === null) return;
      const { x, y } = svgCoords(ev);
      const sorted = [...activePoints].sort((a, b) => a.x - b.x);
      const realIdx = sorted.indexOf(activePoints[draggingIdx.current]);
      const isEndpoint = activePoints[draggingIdx.current].x === 0 || activePoints[draggingIdx.current].x === 1;
      const newPt: CurvePoint = isEndpoint
        ? { x: activePoints[draggingIdx.current].x, y }
        : { x, y };
      const next = activePoints.map((p, i) => (i === draggingIdx.current ? newPt : p));
      updateChannel(next);
    }

    function onUp() {
      draggingIdx.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handlePointDoubleClick(e: React.MouseEvent, idx: number) {
    e.stopPropagation();
    const pt = activePoints[idx];
    if (pt.x === 0 || pt.x === 1) return; // endpoints are permanent
    updateChannel(activePoints.filter((_, i) => i !== idx));
  }

  const color = CHANNEL_COLOR[activeChannel];
  const channels: Channel[] = ["rgb", "r", "g", "b"];
  const channelLabels: Record<Channel, string> = { rgb: "RGB", r: "R", g: "G", b: "B" };

  return (
    <div className="space-y-2">
      {/* Channel tabs */}
      <div className="flex gap-1">
        {channels.map((ch) => (
          <button
            key={ch}
            type="button"
            onClick={() => setActiveChannel(ch)}
            className="px-2 py-0.5 text-[10px] rounded font-semibold transition-colors"
            style={{
              color: activeChannel === ch ? CHANNEL_COLOR[ch] : "#71717a",
              background: activeChannel === ch ? "rgba(255,255,255,0.07)" : "transparent",
            }}
          >
            {channelLabels[ch]}
          </button>
        ))}
      </div>

      {/* SVG canvas */}
      <svg
        ref={svgRef}
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full rounded cursor-crosshair select-none"
        style={{ background: "#1a1a1a", display: "block" }}
        onClick={handleSvgClick}
      >
        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map((v) => (
          <g key={v}>
            <line
              x1={toSvgX(v)} y1={PAD} x2={toSvgX(v)} y2={PAD + INNER}
              stroke="#2a2a2a" strokeWidth="1"
            />
            <line
              x1={PAD} y1={toSvg(v)} x2={PAD + INNER} y2={toSvg(v)}
              stroke="#2a2a2a" strokeWidth="1"
            />
          </g>
        ))}

        {/* Identity reference line */}
        <line
          x1={toSvgX(0)} y1={toSvg(0)} x2={toSvgX(1)} y2={toSvg(1)}
          stroke="#3a3a3a" strokeWidth="1" strokeDasharray="3 3"
        />

        {/* Curve path */}
        <path
          d={catmullRomPath(activePoints)}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
        />

        {/* Control points */}
        {activePoints.map((pt, idx) => (
          <circle
            key={idx}
            cx={toSvgX(pt.x)}
            cy={toSvg(pt.y)}
            r={hoveredIdx === idx ? 5 : 4}
            fill={color}
            stroke="#1a1a1a"
            strokeWidth="1.5"
            style={{ cursor: "grab" }}
            onMouseEnter={() => setHoveredIdx(idx)}
            onMouseLeave={() => setHoveredIdx(null)}
            onMouseDown={(e) => handlePointMouseDown(e, idx)}
            onDoubleClick={(e) => handlePointDoubleClick(e, idx)}
          />
        ))}
      </svg>

      {/* Reset hint */}
      <p className="text-[10px] text-zinc-600">
        点击添加控制点 · 双击删除 · 端点只能上下移动
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/ry2019/private/FujiSim && npm run build 2>&1 | grep -E "error|Error" | head -20
```

Expected: no TypeScript errors related to CurvesEditor.

- [ ] **Step 3: Commit**

```bash
git add src/components/CurvesEditor.tsx
git commit -m "feat: add CurvesEditor SVG component"
```

---

### Task 7: Integrate CurvesEditor into FilterPanel

**Files:**
- Modify: `src/components/FilterPanel.tsx`

- [ ] **Step 1: Add import for CurvesEditor**

In `src/components/FilterPanel.tsx`, add to the imports section:

```tsx
import { CurvesEditor } from "@/components/CurvesEditor";
import type { ToneCurvePoints } from "@/types";
```

- [ ] **Step 2: Change TabsList from 4 to 5 columns**

In `src/components/FilterPanel.tsx` at line 162, change:

```tsx
<TabsList className="w-full grid grid-cols-4">
```

to:

```tsx
<TabsList className="w-full grid grid-cols-5">
```

- [ ] **Step 3: Add the Curves tab trigger**

After the `info` TabsTrigger (line 166), add:

```tsx
<TabsTrigger value="curves">{t("filterPanel.tabs.curves")}</TabsTrigger>
```

- [ ] **Step 4: Add the Curves TabsContent**

After the closing `</TabsContent>` of the `adjust` tab (after line 270), add:

```tsx
<TabsContent value="curves" className="flex-1 overflow-y-auto px-4 pb-6 mt-4">
  <CurvesEditor
    value={filter.tone_curve}
    onChange={(tc: ToneCurvePoints) => setFilter({ tone_curve: tc })}
  />
</TabsContent>
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/ry2019/private/FujiSim && npm run build 2>&1 | grep -E "error|Error" | head -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/FilterPanel.tsx
git commit -m "feat: add Curves tab to FilterPanel with CurvesEditor"
```

---

### Task 8: Full build verification

**Files:** none (verification only)

- [ ] **Step 1: Full Rust build**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo build 2>&1 | tail -30
```

Expected: `Compiling fujisim ...` then `Finished`. No errors.

- [ ] **Step 2: Full frontend build**

```bash
cd /Users/ry2019/private/FujiSim && npm run build 2>&1 | tail -20
```

Expected: `✓ built in` with no errors.

- [ ] **Step 3: Commit if any fixes were needed**

```bash
git add -p
git commit -m "fix: resolve build issues from tone curve integration"
```

---

## Self-Review

**Spec coverage check:**
- ✅ `CurvePoint` / `ToneCurvePoints` types — Task 1 & 2
- ✅ `splines = "5.0.0"` dependency — Task 2
- ✅ `ToneCurve::from_points` with CatmullRom + ghost points — Task 3
- ✅ Pipeline step `[2b]` with pre-built LUTs — Task 4
- ✅ `is_identity()` updated — Task 2 Step 4
- ✅ `DEFAULT_FILTER` updated — Task 1 Step 2
- ✅ SVG editor: grid, identity line, draggable points, add/delete — Task 6
- ✅ Channel tabs RGB/R/G/B with color coding — Task 6
- ✅ Endpoints fixed (x locked, y movable) — Task 6
- ✅ i18n strings — Task 5
- ✅ FilterPanel integration with 5-column grid — Task 7

**Type consistency check:**
- `CurvePoint` defined in `types.ts` (Task 1) and `pipeline.rs` (Task 2) — both used consistently
- `ToneCurvePoints` fields `rgb/r/g/b` match across all tasks
- `curves[activeChannel]` in CurvesEditor correctly indexes `ToneCurvePoints`
- `ToneCurve::from_points` takes `&[CurvePoint]` from `pipeline.rs` — imported in `curves.rs` Task 3

**Placeholder scan:** No TBD/TODO found. All code steps are complete.

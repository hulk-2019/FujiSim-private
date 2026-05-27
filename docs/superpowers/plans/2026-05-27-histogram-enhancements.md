# Histogram 增强功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `Histogram.tsx` 中添加 EXIF 信息条、通道点击切换、帧间形状插值动画三项增强。

**Architecture:** 全部前端改动。`HistogramSection` 增加 `focused` asset 订阅、通过 props 传给 `Histogram`。`Histogram` 组件内部维护通道开关 `useState` 与动画状态机（5 个 ref + RAF 循环）。`drawHistogram` 签名调整为接收 `displayed` 帧（已 sqrt）+ `enabled` 通道开关。后端、IPC、useHistogramSync hook 全部不动。

**Tech Stack:** React, TypeScript, Canvas 2D, requestAnimationFrame, Zustand store, react-i18next

---

## 任务顺序

按 spec §9 的实施顺序：

1. **Task 1**：EXIF 信息条（最简单，不影响绘制路径）
2. **Task 2**：通道切换（修 drawHistogram 签名，但仍是静态绘制）
3. **Task 3**：形状插值动画（最复杂，引入 RAF 状态机）

每个任务独立 commit，独立可验证。

---

## Task 1: EXIF 信息条

**Files:**
- Modify: `src/components/Histogram.tsx`
- Modify: `src/components/FilterPanel/HistogramSection.tsx`

### Step 1: 修改 HistogramSection 注入 focused asset

替换 `src/components/FilterPanel/HistogramSection.tsx` 全部内容为：

```tsx
import { useStore } from "@/store";
import { Histogram } from "@/components/Histogram";

export function HistogramSection() {
  const histogram = useStore((s) => s.histogram);
  const focusedId = useStore((s) => s.focusedId);
  const assets = useStore((s) => s.assets);
  const focused = assets.find((a) => a?.id === focusedId) ?? null;
  return <Histogram data={histogram} asset={focused} />;
}
```

- [ ] **Step 2: 在 Histogram.tsx 增加 asset prop + ExifBar 子组件**

打开 `src/components/Histogram.tsx`：

a. 顶部 import 新增 `Asset` 类型：

```tsx
import type { HistogramData, Asset } from "@/types";
```

把现有的：
```tsx
import type { HistogramData } from "@/types";
```
替换为上面那行。

b. 修改 `HistogramProps` 接口（约第 8-11 行）：

```tsx
interface HistogramProps {
  data: HistogramData | null;
  asset?: Asset | null;
  height?: number;
}
```

c. 修改 `Histogram` 组件签名（约第 92 行）：

```tsx
export function Histogram({ data, asset = null, height = 120 }: HistogramProps) {
```

d. 在组件 return 的 outer `<div>` 内、`{/* clip warnings 那个 div */}` 之后追加 `<ExifBar asset={asset} />`，最终 return 结构应该是：

```tsx
return (
  <div className="w-full">
    <div className="flex items-center gap-3 px-2 py-1 text-[10px] text-zinc-400">
      <ChannelDot color="rgb(220,220,220)" label={t("histogram.channels.luma")} />
      <ChannelDot color="rgb(220,80,80)" label={t("histogram.channels.r")} />
      <ChannelDot color="rgb(80,200,80)" label={t("histogram.channels.g")} />
      <ChannelDot color="rgb(100,120,220)" label={t("histogram.channels.b")} />
    </div>
    <div ref={containerRef} className="relative w-full rounded overflow-hidden">
      <canvas ref={canvasRef} />
      {clip.shadow > CLIP_THRESHOLD && (
        /* shadow triangle, unchanged */
      )}
      {clip.highlight > CLIP_THRESHOLD && (
        /* highlight triangle, unchanged */
      )}
    </div>
    <ExifBar asset={asset} />
  </div>
);
```

e. 在文件末尾（`computeClip` 之后）新增 `ExifBar` 私有组件：

```tsx
function ExifBar({ asset }: { asset: Asset | null }) {
  if (!asset) return null;
  const { iso, focal_length, f_number, shutter_speed } = asset;
  const allMissing =
    iso == null && focal_length == null && f_number == null && shutter_speed == null;
  if (allMissing) return null;

  const items = [
    iso != null ? `ISO ${iso}` : "—",
    focal_length != null ? `${focal_length}mm` : "—",
    f_number != null ? `f/${f_number.toFixed(1)}` : "—",
    shutter_speed != null ? `${shutter_speed}s` : "—",
  ];

  return (
    <div className="flex items-center gap-2 px-2 py-1 text-[10px] text-zinc-500">
      {items.map((s, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 && <span className="text-zinc-700">·</span>}
          <span>{s}</span>
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: TypeScript 检查**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit`
Expected: 通过，无错误。

- [ ] **Step 4: 行数检查**

Run: `wc -l /Users/ry2019/private/FujiSim/src/components/Histogram.tsx`
Expected: ≤ 220（spec §6 给出 220-260 接近上限，单独 Task 1 应在 200 上下）。

- [ ] **Step 5: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src/components/Histogram.tsx src/components/FilterPanel/HistogramSection.tsx
git commit -m "feat(histogram): add EXIF info bar (ISO/focal/aperture/shutter)"
```

---

## Task 2: 通道点击切换

**Files:**
- Modify: `src/components/Histogram.tsx`

### Step 1: 增加 enabled 状态与切换函数

在 `Histogram` 组件函数体最顶部（`useTranslation()` 之后）插入：

```tsx
  const [enabled, setEnabled] = useState({ luma: true, r: true, g: true, b: true });

  const toggleChannel = useCallback(
    (key: "luma" | "r" | "g" | "b") =>
      setEnabled((prev) => ({ ...prev, [key]: !prev[key] })),
    [],
  );
```

### Step 2: 修改 drawHistogram 签名加 enabled 参数

把 `drawHistogram` 函数（约第 13-90 行）签名与内部逻辑改为：

```tsx
function drawHistogram(
  canvas: HTMLCanvasElement,
  container: HTMLDivElement,
  data: HistogramData | null,
  height: number,
  enabled: { r: boolean; g: boolean; b: boolean; luma: boolean },
) {
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth;
  const h = height;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = "rgb(24 24 27)";
  ctx.fillRect(0, 0, w, h);

  if (!data) return;

  const { r, g, b, luma } = data;
  const bins = 256;

  const sqrtR = r.map((v) => Math.sqrt(v));
  const sqrtG = g.map((v) => Math.sqrt(v));
  const sqrtB = b.map((v) => Math.sqrt(v));
  const sqrtLuma = luma.map((v) => Math.sqrt(v));

  // RGB max only considers enabled RGB channels
  let rgbMax = 0;
  for (let i = 0; i < bins; i++) {
    if (enabled.r) rgbMax = Math.max(rgbMax, sqrtR[i]);
    if (enabled.g) rgbMax = Math.max(rgbMax, sqrtG[i]);
    if (enabled.b) rgbMax = Math.max(rgbMax, sqrtB[i]);
  }
  let lumaMax = 0;
  if (enabled.luma) {
    for (let i = 0; i < bins; i++) {
      lumaMax = Math.max(lumaMax, sqrtLuma[i]);
    }
  }

  if (rgbMax === 0 && lumaMax === 0) return;

  const drawChannel = (channel: number[], maxVal: number, color: string) => {
    if (maxVal === 0) return;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < bins; i++) {
      const x = (i / (bins - 1)) * w;
      const y = h - (channel[i] / maxVal) * (h - 1);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };

  ctx.globalCompositeOperation = "source-over";
  if (enabled.luma) drawChannel(sqrtLuma, lumaMax, "rgba(220,220,220,0.35)");

  ctx.globalCompositeOperation = "lighter";
  if (enabled.r) drawChannel(sqrtR, rgbMax, "rgba(180,40,40,0.65)");
  if (enabled.g) drawChannel(sqrtG, rgbMax, "rgba(40,150,40,0.65)");
  if (enabled.b) drawChannel(sqrtB, rgbMax, "rgba(40,60,180,0.65)");

  ctx.globalCompositeOperation = "source-over";
}
```

### Step 3: 把 enabled 传给 drawHistogram + 加进 useEffect 依赖

定位 `Histogram` 组件内的 `useEffect`（约第 100-105 行）：

```tsx
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    drawHistogram(canvas, container, data, height);
  }, [data, height, resizeKey]);
```

改为：

```tsx
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    drawHistogram(canvas, container, data, height, enabled);
  }, [data, height, resizeKey, enabled]);
```

### Step 4: 改 ChannelDot 为按钮 + 加 enabled 视觉反馈

替换 `ChannelDot` 函数（约第 158-167 行）整体为：

```tsx
function ChannelDot({
  color,
  label,
  enabled,
  onToggle,
}: {
  color: string;
  label: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      className={`inline-flex items-center gap-1 border-0 bg-transparent p-0 cursor-pointer transition-opacity ${
        enabled ? "text-zinc-300" : "text-zinc-600"
      }`}
    >
      <span
        className="inline-block w-2 h-2 rounded-full transition-opacity"
        style={{ backgroundColor: color, opacity: enabled ? 1 : 0.3 }}
      />
      {label}
    </button>
  );
}
```

### Step 5: 渲染 4 个 ChannelDot 时传 enabled / onToggle

定位组件 return 中的 4 个 `<ChannelDot>` 调用（约第 119-124 行），整段替换为：

```tsx
      <div className="flex items-center gap-3 px-2 py-1 text-[10px]">
        <ChannelDot
          color="rgb(220,220,220)"
          label={t("histogram.channels.luma")}
          enabled={enabled.luma}
          onToggle={() => toggleChannel("luma")}
        />
        <ChannelDot
          color="rgb(220,80,80)"
          label={t("histogram.channels.r")}
          enabled={enabled.r}
          onToggle={() => toggleChannel("r")}
        />
        <ChannelDot
          color="rgb(80,200,80)"
          label={t("histogram.channels.g")}
          enabled={enabled.g}
          onToggle={() => toggleChannel("g")}
        />
        <ChannelDot
          color="rgb(100,120,220)"
          label={t("histogram.channels.b")}
          enabled={enabled.b}
          onToggle={() => toggleChannel("b")}
        />
      </div>
```

注：把外层 `<div>` 的 `text-zinc-400` 移除（因为现在颜色由 ChannelDot 内部 enabled 状态决定）。

### Step 6: TypeScript 检查

Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit`
Expected: 通过。

### Step 7: 行数检查

Run: `wc -l /Users/ry2019/private/FujiSim/src/components/Histogram.tsx`
Expected: 仍 ≤ 230。

### Step 8: Commit

```bash
cd /Users/ry2019/private/FujiSim
git add src/components/Histogram.tsx
git commit -m "feat(histogram): channel toggle via clickable color dots"
```

---

## Task 3: 帧间形状插值动画

**Files:**
- Modify: `src/components/Histogram.tsx`

> **关键陷阱**（spec §7.5）：`animFromRef.current = displayedRef.current` 必须深拷贝，否则下一帧 lerp 会同时改 from 和 displayed，动画停滞。

### Step 1: 顶部加常量与帮助函数

在 `Histogram.tsx` 顶部（`CLIP_THRESHOLD` 常量之后、`HistogramProps` 之前）追加：

```tsx
const ANIM_DURATION_MS = 180;

type HistFrame = { r: number[]; g: number[]; b: number[]; luma: number[] };

function makeZeros(): HistFrame {
  return {
    r: new Array(256).fill(0),
    g: new Array(256).fill(0),
    b: new Array(256).fill(0),
    luma: new Array(256).fill(0),
  };
}

function cloneFrame(f: HistFrame): HistFrame {
  return {
    r: f.r.slice(),
    g: f.g.slice(),
    b: f.b.slice(),
    luma: f.luma.slice(),
  };
}

function sqrtify(data: HistogramData): HistFrame {
  return {
    r: data.r.map((v) => Math.sqrt(v)),
    g: data.g.map((v) => Math.sqrt(v)),
    b: data.b.map((v) => Math.sqrt(v)),
    luma: data.luma.map((v) => Math.sqrt(v)),
  };
}

function lerpFrame(from: HistFrame, target: HistFrame, eased: number): HistFrame {
  const lerp = (a: number[], b: number[]) =>
    a.map((v, i) => v + (b[i] - v) * eased);
  return {
    r: lerp(from.r, target.r),
    g: lerp(from.g, target.g),
    b: lerp(from.b, target.b),
    luma: lerp(from.luma, target.luma),
  };
}
```

### Step 2: 改 drawHistogram 接收 displayed 帧（已 sqrt）

把 `drawHistogram` 函数签名改为接受 `displayed: HistFrame | null`，并去掉内部的 sqrt 计算（因为外部已 sqrt）。整段函数替换为：

```tsx
function drawHistogram(
  canvas: HTMLCanvasElement,
  container: HTMLDivElement,
  displayed: HistFrame | null,
  height: number,
  enabled: { r: boolean; g: boolean; b: boolean; luma: boolean },
) {
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth;
  const h = height;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = "rgb(24 24 27)";
  ctx.fillRect(0, 0, w, h);

  if (!displayed) return;

  const { r, g, b, luma } = displayed;
  const bins = 256;

  let rgbMax = 0;
  for (let i = 0; i < bins; i++) {
    if (enabled.r) rgbMax = Math.max(rgbMax, r[i]);
    if (enabled.g) rgbMax = Math.max(rgbMax, g[i]);
    if (enabled.b) rgbMax = Math.max(rgbMax, b[i]);
  }
  let lumaMax = 0;
  if (enabled.luma) {
    for (let i = 0; i < bins; i++) {
      lumaMax = Math.max(lumaMax, luma[i]);
    }
  }

  if (rgbMax === 0 && lumaMax === 0) return;

  const drawChannel = (channel: number[], maxVal: number, color: string) => {
    if (maxVal === 0) return;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < bins; i++) {
      const x = (i / (bins - 1)) * w;
      const y = h - (channel[i] / maxVal) * (h - 1);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };

  ctx.globalCompositeOperation = "source-over";
  if (enabled.luma) drawChannel(luma, lumaMax, "rgba(220,220,220,0.35)");

  ctx.globalCompositeOperation = "lighter";
  if (enabled.r) drawChannel(r, rgbMax, "rgba(180,40,40,0.65)");
  if (enabled.g) drawChannel(g, rgbMax, "rgba(40,150,40,0.65)");
  if (enabled.b) drawChannel(b, rgbMax, "rgba(40,60,180,0.65)");

  ctx.globalCompositeOperation = "source-over";
}
```

### Step 3: 在 Histogram 组件内增加动画状态机

替换组件内现有的：

```tsx
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    drawHistogram(canvas, container, data, height, enabled);
  }, [data, height, resizeKey, enabled]);
```

为以下完整动画状态机：

```tsx
  // === Animation state machine ===
  const displayedRef = useRef<HistFrame | null>(null);
  const targetRef = useRef<HistFrame | null>(null);
  const animFromRef = useRef<HistFrame | null>(null);
  const animStartRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    drawHistogram(canvas, container, displayedRef.current, height, enabled);
  }, [enabled, height]);

  // Start or continue the animation loop. No-op if already running.
  const ensureRaf = useCallback(() => {
    if (rafRef.current != null) return;
    const tick = (now: number) => {
      const from = animFromRef.current;
      const target = targetRef.current;
      if (!from || !target) {
        rafRef.current = null;
        return;
      }
      const t = Math.min(1, (now - animStartRef.current) / ANIM_DURATION_MS);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      displayedRef.current = lerpFrame(from, target, eased);
      redraw();
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        displayedRef.current = target;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [redraw]);

  // Data updates: snapshot current displayed as `from`, set new target, kick RAF.
  useEffect(() => {
    if (!data) {
      targetRef.current = null;
      displayedRef.current = null;
      animFromRef.current = null;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      redraw();
      return;
    }
    const newTarget = sqrtify(data);
    animFromRef.current = displayedRef.current
      ? cloneFrame(displayedRef.current)
      : makeZeros();
    targetRef.current = newTarget;
    animStartRef.current = performance.now();
    ensureRaf();
  }, [data, redraw, ensureRaf]);

  // Enabled toggle / resize: just redraw with current displayed frame, no animation.
  useEffect(() => {
    redraw();
  }, [enabled, resizeKey, redraw]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);
```

### Step 4: TypeScript 检查

Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit`
Expected: 通过。

### Step 5: 行数检查

Run: `wc -l /Users/ry2019/private/FujiSim/src/components/Histogram.tsx`
Expected: ≤ 280。如超 280，需把 `drawHistogram` + 动画 helpers 抽到 `src/lib/histogramDraw.ts`（只在超出时做）。

### Step 6: dev 验证

Run: `cd /Users/ry2019/private/FujiSim && pnpm tauri dev`
手动验证：
1. 切换照片：直方图应从 0 渐入到目标分布（180ms 缓动）
2. 拖动曝光滑块：直方图形状应连续流动，不是离散跳变
3. 快速连续拖滑块：动画应"折返"——从当前位置无缝过渡到下一个目标，不是从 0 重新开始
4. 关掉某个通道（如 R）：立即生效，无淡出动画
5. 关掉所有通道：画布只剩背景色
6. 切到没数据的占位图（focused 为 null）：直方图清空
7. Ctrl+C 停止

### Step 7: Commit

```bash
cd /Users/ry2019/private/FujiSim
git add src/components/Histogram.tsx
git commit -m "feat(histogram): 180ms easeOutCubic shape interpolation animation"
```

---

## Task 4: 收尾验证

### Step 1: 整体行数检查

Run:
```bash
cd /Users/ry2019/private/FujiSim
wc -l src/components/Histogram.tsx
wc -l src/components/FilterPanel/HistogramSection.tsx
```
Expected:
- `Histogram.tsx` ≤ 280
- `HistogramSection.tsx` ≤ 30

### Step 2: TypeScript 全量检查

Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit`
Expected: 通过。

### Step 3: 后端无回归（影子检查）

Run: `cd /Users/ry2019/private/FujiSim/src-tauri && cargo check`
Expected: 通过（本次没改后端，应该 instant pass）。

### Step 4: 完整手动验证

Run: `cd /Users/ry2019/private/FujiSim && pnpm tauri dev`

按 §6 风险与回归点逐一验证：
1. **动画连续过渡**：快速拖滑块，直方图形状连续流动
2. **enabled 切换不参与动画**：点击通道色点立即生效
3. **ChannelDot 键盘可达**：Tab 到色点，Enter / Space 切换
4. **EXIF 全空整行隐藏**：导入一张无 EXIF 的 PNG，信息条不出现
5. **EXIF 部分缺失填占位**：找一张缺 ISO 的图，应显示 `— · 35mm · f/2.8 · 1/200s`

不 commit（无代码改动）。

---

## 自我审查清单

阅读全部任务后逐项对照 spec 检查：

- ✅ §3.1 enabled state → Task 2 Step 1
- ✅ §3.2 ChannelDot 改 button + opacity 0.3 → Task 2 Step 4-5
- ✅ §3.3 drawHistogram 签名 + 跳过禁用通道 → Task 2 Step 2 → Task 3 Step 2
- ✅ §3.4 全部禁用画布只剩背景 → Task 2 Step 2 (rgbMax/lumaMax 都为 0 时 early return)
- ✅ §4.1 5 个 ref → Task 3 Step 3
- ✅ §4.2 数据进来 lerp → Task 3 Step 3 (data useEffect)
- ✅ §4.3 RAF easeOutCubic 180ms → Task 3 Step 3 (ensureRaf)
- ✅ §4.4 动画期间收新数据折返 → Task 3 Step 3 (animFrom = clone(displayed))
- ✅ §4.5 enabled 切换不动画 → Task 3 Step 3 (separate useEffect [enabled, resizeKey])
- ✅ §4.6 卸载清理 → Task 3 Step 3 (unmount useEffect)
- ✅ §5.1 HistogramSection 注入 asset → Task 1 Step 1
- ✅ §5.2 ExifBar 子组件 → Task 1 Step 2e
- ✅ §5.3 渲染位置在 containerRef 同级之外 → Task 1 Step 2d
- ✅ §5.4 字段格式 → Task 1 Step 2e
- ✅ §7.5 cloneFrame 防止引用共享 → Task 3 Step 1 + Step 3 (animFromRef = cloneFrame(displayed))

无 placeholder。类型一致：`HistFrame` 在 Task 3 Step 1 定义、Step 2/3 使用；`HistogramProps` 在 Task 1 Step 2b 扩展、Task 2 不变、Task 3 不变；`enabled` 在 Task 2 Step 1 定义、Step 2/3 使用，Task 3 中 redraw 引用相同 enabled state。

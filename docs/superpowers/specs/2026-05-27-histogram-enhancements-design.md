# Histogram 增强功能设计

**日期**: 2026-05-27
**作者**: hong.rong
**状态**: 待实施
**前序**: [2026-05-27-filter-panel-histogram-refactor-design.md](./2026-05-27-filter-panel-histogram-refactor-design.md)

## 1. 背景

直方图重构落地后用户反馈了 4 项后续需求：

1. 通过点击顶部色点切换通道显隐
2. 直方图变化时希望有动画过渡（"丝滑"）
3. 直方图底部展示 ISO / 焦段 / 光圈 / 快门
4. 调整 CPU 占用略升，需性能优化

**本次 spec 只覆盖前 3 项**。第 4 项（性能优化）独立成另一个设计/实施周期，原因：
- 性能优化路线选择影响后端架构（前端从 preview 算 vs 工作尺寸再降），需独立讨论
- 前 3 项是纯前端改动、不动后端、不动 IPC 通道，可独立交付且零回归风险

## 2. 目标

[src/components/Histogram.tsx](../../../src/components/Histogram.tsx) 与 [src/components/FilterPanel/HistogramSection.tsx](../../../src/components/FilterPanel/HistogramSection.tsx) 增加：

| 功能 | 验证标志 |
|------|---------|
| 通道点击切换 | 4 个色点变成可点击按钮，被禁用通道色点透明、文字变暗，画布上不再绘制该通道 |
| 形状插值动画 | 数据变化时 ~180ms easeOutCubic 过渡，60fps 顺滑；动画期间收新数据从当前帧折返到新目标 |
| EXIF 信息条 | 直方图底部显示 4 槽位 `ISO {x} · {focal}mm · f/{f} · 1/{shutter}s`，缺失字段填 `—`，4 项全空整行隐藏 |

不动后端、不动 IPC、不动 useHistogramSync hook、不影响其他组件。

## 3. 通道切换

### 3.1 状态

`Histogram` 组件内部维护：

```ts
const [enabled, setEnabled] = useState({ luma: true, r: true, g: true, b: true });
```

不持久化（切换照片不主动重置；状态跟组件实例走，组件保持挂载状态期间不丢）。无需保存到 localStorage 或 store。

### 3.2 ChannelDot 改造

现有 `<span>` 改为 `<button type="button">`：
- 启用：色点饱和、文字 `text-zinc-300`
- 禁用：色点 `opacity: 0.3`（保留色相不变灰）、文字 `text-zinc-600`
- `aria-pressed` 反映当前状态
- 点击切换对应通道，调 `setEnabled(prev => ({ ...prev, [key]: !prev[key] }))`
- 保留键盘可达性（`<button>` 默认 tabindex）

### 3.3 drawHistogram 签名

新增两个参数：

```ts
function drawHistogram(
  canvas: HTMLCanvasElement,
  container: HTMLDivElement,
  height: number,
  enabled: { r: boolean; g: boolean; b: boolean; luma: boolean },
  displayed: { r: number[]; g: number[]; b: number[]; luma: number[] } | null,
)
```

> 注意：原签名传 `data: HistogramData | null`。新签名改为接收 `displayed`（已经是 sqrt 后的当前展示帧），sqrt 处理移到 useEffect 内。

被禁用通道的处理：
- 不参与 `rgbMax` / `lumaMax` 计算
- 不调用 `drawChannel`
- 全部禁用时画布只剩背景色（不显示 placeholder 文字）

### 3.4 全部禁用情形

合法状态。直方图区域只剩背景，用户能从灰色色点理解原因，无需引导文字。

## 4. 形状插值动画

### 4.1 状态机

`Histogram` 组件维护：

```ts
const displayedRef = useRef<{r:number[],g:number[],b:number[],luma:number[]}|null>(null);
const targetRef    = useRef<{r:number[],g:number[],b:number[],luma:number[]}|null>(null);
const animFromRef  = useRef<{r:number[],g:number[],b:number[],luma:number[]}|null>(null);
const animStartRef = useRef<number>(0);
const rafRef       = useRef<number | null>(null);
```

数据语义：所有 ref 存的是 **sqrt 压缩后** 的数组（256 长度），归一化由 drawHistogram 内部完成。

### 4.2 数据更新触发

`useEffect` 依赖 `[data]`：

```ts
useEffect(() => {
  if (!data) {
    targetRef.current = null;
    displayedRef.current = null;
    cancelAnimation();
    redraw();
    return;
  }
  const newTarget = sqrtify(data);
  animFromRef.current = displayedRef.current ?? zeros(); // 起始帧 = 当前展示
  targetRef.current = newTarget;
  animStartRef.current = performance.now();
  startAnimationIfNotRunning();
}, [data]);
```

### 4.3 RAF 循环

```ts
const DURATION_MS = 180;

function tick(now: number) {
  const from = animFromRef.current;
  const target = targetRef.current;
  if (!from || !target) { rafRef.current = null; return; }

  const t = Math.min(1, (now - animStartRef.current) / DURATION_MS);
  const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic

  const lerp = (a: number[], b: number[]) =>
    a.map((v, i) => v + (b[i] - v) * eased);

  displayedRef.current = {
    r: lerp(from.r, target.r),
    g: lerp(from.g, target.g),
    b: lerp(from.b, target.b),
    luma: lerp(from.luma, target.luma),
  };
  redraw();

  if (t < 1) {
    rafRef.current = requestAnimationFrame(tick);
  } else {
    // 动画到达目标，from 不再用，display = target
    displayedRef.current = target;
    rafRef.current = null;
  }
}
```

### 4.4 动画期间收到新数据

`useEffect` 触发时：
1. `animFromRef = displayedRef.current` 当前帧（**已被 lerp 推进过**）的快照
2. `targetRef = newTarget`
3. `animStartRef = performance.now()`
4. RAF 已在跑则不重启（tick 下一帧自然读到新的 from/target/start，从当前位置折返）

### 4.5 启用/禁用通道时

`enabled` 变化不触发动画——只重绘当前 `displayed` 用新的 enabled 参数。瞬时显隐自然，无延迟感。

### 4.6 卸载清理

```ts
useEffect(() => {
  return () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  };
}, []);
```

### 4.7 性能预算

- 256 bin × 4 通道 × 60fps = 61,440 lerp ops/秒
- 每帧 lerp 约 0.3ms，drawHistogram 约 0.5ms，远低于 16ms 预算
- 无 GC 压力（lerp 创建 4 个新数组/帧 = 4KB/frame，可接受）

## 5. EXIF 信息条

### 5.1 数据流变化

`HistogramSection.tsx` 增加 store 订阅：

```tsx
import { useStore } from "@/store";

export function HistogramSection() {
  const histogram = useStore((s) => s.histogram);
  const focusedId = useStore((s) => s.focusedId);
  const assets = useStore((s) => s.assets);
  const focused = assets.find((a) => a?.id === focusedId) ?? null;
  return <Histogram data={histogram} asset={focused} />;
}
```

`Histogram` 接收新 prop：

```ts
interface HistogramProps {
  data: HistogramData | null;
  asset: Asset | null;
  height?: number;
}
```

### 5.2 ExifBar 子组件

私有 helper（同文件）：

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

### 5.3 渲染位置

```tsx
<div className="w-full">
  <div /* channel legend */>...</div>
  <div ref={containerRef} /* canvas + clip warnings */>...</div>
  <ExifBar asset={asset} />
</div>
```

`ExifBar` 在 `containerRef` 同级、之外。`ResizeObserver` 不会监听到信息条，画布尺寸不受影响。

### 5.4 字段格式定义

| 字段 | 数据库类型 | 渲染 | 缺失 |
|------|----------|------|------|
| `iso` | `number \| null` | `ISO {iso}` | `—` |
| `focal_length` | `number \| null` | `{focal_length}mm` | `—` |
| `f_number` | `number \| null` | `f/{f_number.toFixed(1)}` | `—` |
| `shutter_speed` | `string \| null`（如 "1/125"）| `{shutter_speed}s` | `—` |

### 5.5 i18n

本次 ExIF 字段固定格式不需要 i18n（数字 + 单位都是国际通用）。占位符 `—` 也直接硬编码（不像之前的 `histogram.shadowClip` 是带翻译变量的句子）。

如未来有"ISO 200" 需要本地化（如中文"感光度 200"），再加翻译键。

## 6. 文件改动清单

修改：
- `src/components/Histogram.tsx`：
  - 新增 `useState<{r,g,b,luma}>` 通道开关
  - `ChannelDot` 改为 `<button>`，加 `enabled`/`onToggle` props
  - 新增 5 个 ref + RAF 动画状态机
  - `drawHistogram` 签名调整接收 `displayed` 与 `enabled`
  - 新增 `ExifBar` 私有组件
  - `HistogramProps` 增 `asset?: Asset | null`
  - 文件预计行数 220-260（接近上限，若超 280 抽出 `lib/histogramDraw.ts` 与 `lib/histogramAnim.ts`）
- `src/components/FilterPanel/HistogramSection.tsx`：
  - 新增 `focusedId` / `assets` store 订阅
  - 把 `focused` asset 通过 `asset` prop 传给 `<Histogram>`

不动：
- 后端 IPC、Rust 代码、useHistogramSync hook、PreviewPanel、其他 FilterPanel 子组件

## 7. 风险与回归

1. **动画状态机**：from/target/animStart 三 ref 必须配对更新，否则会出现"动画期间数据更新但起点不对"的视觉跳变。测试方法：快速拖滑块连续触发新数据，观察直方图是否有"瞬移"
2. **enabled toggle 与动画交互**：动画期间切换通道——预期是切换通道**立即生效**（不参与动画），动画继续按原 from/target 推进。这要求 redraw 函数读 `enabled` ref（最新值）+ `displayed` ref（动画当前帧）
3. **ChannelDot 从 span 变 button**：CSS 重置（`<button>` 默认有 padding/border），需要显式 `border-0 bg-transparent p-0` 清掉
4. **Asset prop 与 React.memo**：未来若 `Histogram` 加 memo 化，`asset` 引用变化会破坏 memo——本次先不加 memo
5. **animFrom 拷贝**：`animFromRef.current = displayedRef.current` 是赋值引用，下一帧 lerp 又会改 `displayedRef.current`——必须**深拷贝**，否则 from 跟着变会让动画停滞。实现时用 `cloneFrame(displayedRef.current)`

## 8. 不做的事（YAGNI）

- 性能优化（独立 spec 处理）
- `prefers-reduced-motion` 适配（动画 180ms 已经很短，可不做）
- 通道开关键盘快捷键（R/G/B/L 一键切换）
- ExifBar 字段顺序自定义
- ExifBar 中文化（`ISO` → `感光度`）
- 动画时长可配置
- 双击单显模式
- 状态持久化到 store/localStorage

## 9. 实施顺序建议

子任务彼此解耦，可独立交付与回归：

1. **EXIF 信息条**（最简单，不影响动画/绘制路径）
2. **通道切换**（修改 drawHistogram 签名，但仍是静态绘制）
3. **形状插值动画**（最复杂，引入 RAF 状态机；放最后单独验证）

每步完成后跑 `pnpm tsc --noEmit` + 启动 dev 验证。

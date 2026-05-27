# FilterPanel 直方图重构设计

**日期**: 2026-05-27
**作者**: hong.rong
**状态**: 待实施

## 1. 背景

`src/components/FilterPanel.tsx` 当前 671 行，违反项目 CLAUDE.md 规定的 500 行单文件硬限制。文件中"直方图功能"实际上只占两行（`useStore((s) => s.histogram)` + `<Histogram data={histogram} />`），真正的实现散落在三处：

- `src/components/Histogram.tsx`：Canvas 绘制，仅画 R/G/B 三通道（含 sqrt 压缩 + additive blend）
- `src-tauri/src/processing/histogram.rs`：后端 256-bin 直方图计算（已计算 luma 但前端未使用）
- `src/components/PreviewPanel.tsx`：通过 `get_preview` 同步取得直方图数据，在 useEffect [focused?.id, filter] 中以 250ms debounce 触发

### 1.1 现状链路

```
拖滑块 → setFilter(patch) → zustand store
  ↓ PreviewPanel useEffect [focused?.id, filter] 250ms debounce
api.getPreview(asset_id, filter, 1920, token)
  ↓ Tauri IPC → spawn_blocking
解码 RAW/普通图 → resize 1920 → process_image → histogram::compute
  ↓
JPEG encode 88 → 写盘 temp_dir → 返回 PreviewResult { path, width, height, histogram }
  ↓
setPreview / setHistogram → <Histogram> 重绘
```

### 1.2 现状问题清单

按严重度分类：

**严重**

1. **直方图被预览拖累**：直方图只需像素数据，但当前必须等待色彩流水线 → JPEG 编码 → 写盘 → 前端 img 加载。后三步对直方图毫无意义却拖慢了它的更新节奏。
2. **isIdentity 重复且不一致**：`PreviewPanel.tsx:161-209` 与 `:217-265` 各写了一遍超长 isIdentity 检测，**第二份漏了 `wb_shift_g`**——只动 tint 的某些边界场景下 identity 判断会不一致。
3. **RAW + Identity 时直方图消失**：`PreviewPanel.tsx:269-272` 在 `isIdentity && focused.is_raw` 时直接 `return`，没有调用 `setHistogram`，导致用户看 RAW 原图时直方图永远是 null。
4. **luma 通道计算了但未使用**：后端 `histogram.rs:33-36` 老老实实算了 luma，前端从未消费。

**中等**

5. **effect 依赖整对象 filter**：`setFilter` 每次都新建对象引用，`[focused?.id, filter]` 必然每次触发；debounce 救了一命，但本质是设计粗放。
6. **250ms 单一档 debounce**：对预览图（重）合理，对直方图（轻）偏慢。
7. **直方图算在 1920px 图上**：对 256-bin 直方图视觉上几乎无差，CPU 时间能省 ~10×。

**轻量**

8. **无裁剪警告**：高光/阴影爆掉时无视觉提示。
9. **HistogramData 未加 `#[serde(rename_all = "camelCase")]`**：违反 CLAUDE.md §4 强类型对齐要求（凑巧字段都是单字母没暴露问题，但是个坑）。

**结构**

10. **FilterPanel.tsx 671 行**：超过 500 行硬限制。

## 2. 目标

按 a→b→c→d 四阶段串行推进，每阶段单独可验证：

| 阶段 | 范围 | 验证标志 |
|------|------|---------|
| a | 后端 IPC 解耦 + 修两个 isIdentity bug | 拖滑块直方图明显比预览先刷新；RAW identity 下直方图正常 |
| b | 后端瘦身（小图 + serde rename_all + 单元测试） | `cargo clippy` + `cargo test` 通过；CPU 占用下降 |
| c | luma 通道 + 裁剪警告 | 视觉验证 + i18n 完整 |
| d | FilterPanel 拆分到 8 个文件，每文件 ≤ 200 行 | `pnpm lint` 通过；行数检查 |

## 3. 阶段 a：后端 IPC 解耦 + 修复 Bug

### 3.1 后端新增 IPC

新文件 `src-tauri/src/ipc/histogram.rs`：

```rust
#[tauri::command]
pub async fn compute_histogram(
    state: State<'_, SharedState>,
    asset_id: i64,
    settings: Option<FilterSettings>,
    token: u64,
) -> Result<HistogramData>
```

实现要点：
- 复用 `processing::raw::preview_base_path` 缓存（与 `get_preview` 同源），命中时直接读 16-bit TIFF
- **本阶段直接使用 `max_edge = 512`**（一步到位，不分两次提交）
- 走 `state.preview_sem`（同一信号量），与预览共享并发预算，避免抢 CPU
- **新增独立 `state.histogram_token: Arc<AtomicU64>`** 做取消，**不复用 `preview_token`**——两条通道共用 token 会互相误杀
- 流程：解码 → resize 512 → `process_image` → `histogram::compute` → 立即返回，**不写盘、不编 JPEG**

### 3.2 后端修改 get_preview

`PreviewResult` 移除 `histogram` 字段：

```rust
pub struct PreviewResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    // histogram 字段移除
}
```

`get_preview` 内部不再调用 `histogram::compute`。

### 3.3 后端状态扩展

`src-tauri/src/state.rs` 中 `SharedState` 新增字段：

```rust
pub histogram_token: Arc<AtomicU64>,
```

与 `preview_token` 平行，初始化为 0。

### 3.4 注册新命令

`src-tauri/src/lib.rs:56` 的 `tauri::generate_handler!` 宏调用处新增 `compute_histogram` 注册。

### 3.5 前端类型同步

- `src/types.ts` 中 `PreviewResult` 移除 `histogram` 字段
- `src/api.ts` 新增 `computeHistogram(assetId, filter, token): Promise<HistogramData>` 包装

### 3.6 前端 isIdentity 工具函数

新文件 `src/lib/filterIdentity.ts`：

```ts
import type { FilterSettings } from "@/types";

export function isIdentityFilter(filter: FilterSettings): boolean {
  // 合并 PreviewPanel.tsx:161-209 与 :217-265 的两份重复逻辑
  // 补齐第二份漏掉的 wb_shift_g 检查
  // ...
}
```

PreviewPanel.tsx 删除两份内联 isIdentity，统一改用此函数。

### 3.7 前端 useHistogramSync hook

新文件 `src/components/FilterPanel/useHistogramSync.ts`（阶段 d 时与 FilterPanel 一同移到子目录；本阶段先放在 `src/hooks/useHistogramSync.ts`，d 阶段再搬）：

```ts
export function useHistogramSync(
  focusedId: number | null,
  filter: FilterSettings,
): void {
  // 80ms trailing-edge throttle
  // 维护独立 histogramTokenCounter（前端递增）
  // identity + RAW 也照常请求（修 Bug #3）
  // focused 为 null 时 setHistogram(null)
  // 调用 api.computeHistogram → setHistogram
  // 处理 'preview_cancelled' / 'preview_busy' 错误（与 getPreview 同样静默丢弃）
}
```

放在 `HistogramSection`（阶段 d）内部调用，PreviewPanel 不再触碰直方图。本阶段 a 把 hook 放在 `src/hooks/`，由 PreviewPanel 调用一次（暂时位置）。

### 3.8 PreviewPanel 改动

- 删除所有 `setHistogram` 调用
- 删除 `r.histogram` 引用
- 删除两份内联 isIdentity，改用 `isIdentityFilter()`
- 顶部调用 `useHistogramSync(focused?.id, filter)`

### 3.9 阶段 a 完成态

- `get_preview` 不再返回 histogram；`compute_histogram` 独立工作
- 直方图刷新与预览图刷新互不阻塞，两条 token 互不干扰
- isIdentity 只有一份代码、补齐 `wb_shift_g`（修 Bug #2）
- RAW + identity 直方图正常显示（修 Bug #3）
- 拖滑块时感知更轻盈

## 4. 阶段 b：后端瘦身

### 4.1 序列化对齐 CLAUDE.md §4

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistogramData {
    pub r: Vec<u32>,
    pub g: Vec<u32>,
    pub b: Vec<u32>,
    pub luma: Vec<u32>,
    pub total_pixels: u32,  // c2 用于裁剪百分比
}
```

`PreviewResult` 同样补 `#[serde(rename_all = "camelCase")]`（虽然字段都没下划线，但作为规范统一执行）。

`src/types.ts` 中 `HistogramData` 类型同步：
- 导出 `luma: number[]` 字段（c1 使用）
- 导出 `totalPixels: number` 字段（c2 使用）

### 4.2 直方图工作尺寸确认

阶段 a 已经定为 512，本阶段验证：
- 在 8MP 与 24MP 测试图各跑一组
- 直方图视觉上与 1920px 版本逐 bin 对比
- 接受标准：每 bin 占总像素的占比差异 < 0.5%（统计量在足够多采样时收敛）

### 4.3 单元测试

为 `histogram::compute` 添加 `#[cfg(test)]` 模块：
- 输入构造的 4×1 像素 RGB 图
- 验证 r/g/b/luma 各 bin 计数手算结果
- 验证 `total_pixels == width * height`

### 4.4 ts-rs / specta（不做）

CLAUDE.md §4 推荐自动生成 TS 类型，但这是更大的改造。**本次重构不引入**，留作后续独立任务。本次只手动同步 `HistogramData` 字段。

### 4.5 验证

- `cargo clippy --all-targets --all-features -- -D warnings` 通过
- `cargo test` 通过
- 手动跑一次：拖滑块时观测 CPU 占用应明显低于阶段 a 完成态

## 5. 阶段 c：直方图视觉升级

### 5.1 c1 — luma 通道

`Histogram.tsx` 绘制函数调整：

1. **先画 luma**：白色半透明（`rgba(220,220,220,0.35)`），**source-over** 模式画在最底层
2. **再画 R/G/B**：仍用 `lighter` 叠加（与现状一致）
3. luma 走 sqrt 压缩，但用**自身的** maxVal 归一化（与 RGB 共用 maxVal 会让 luma 看起来太矮——像素总数相同但 luma 分布更窄、更高）
4. 顶部加一行 4 个小色点 + 文字标签（`R / G / B / Luma`），**仅作图例，不可点击**（c3 通道切换本次不做）

### 5.2 c2 — 裁剪警告

计算（前端，从已有 HistogramData）：

```ts
const total = data.totalPixels;
const shadowClip = (data.r[0] + data.g[0] + data.b[0]) / (3 * total);
const highlightClip = (data.r[255] + data.g[255] + data.b[255]) / (3 * total);
```

UI：
- 直方图**左上角**小三角（▼ 蓝色）：阴影裁剪 > 0.5% 时显示
- 直方图**右上角**小三角（▼ 红色）：高光裁剪 > 0.5% 时显示
- 三角 `title` 属性显示 tooltip：`阴影裁剪 1.2%` / `高光裁剪 0.4%`（i18n 化）

### 5.3 i18n

新增翻译键，写入 `src/i18n/en.ts` 与 `src/i18n/zh.ts`：

- `histogram.shadowClip`：`阴影裁剪 {{percent}}%` / `Shadow Clip {{percent}}%`
- `histogram.highlightClip`：`高光裁剪 {{percent}}%` / `Highlight Clip {{percent}}%`
- `histogram.channels.r`：`R`
- `histogram.channels.g`：`G`
- `histogram.channels.b`：`B`
- `histogram.channels.luma`：`Luma` / `亮度`

### 5.4 行数控制

`Histogram.tsx` 估计落在 180-220 行。如果接近 250 行，把 `drawHistogram` 抽到 `src/lib/histogramDraw.ts`。

### 5.5 阶段 c 完成态

- 直方图显示 4 通道，luma 用白色半透明垫底
- 顶部图例显示 4 个色点 + 标签
- 高光/阴影裁剪超 0.5% 时角落显示三角警告
- 中英文 i18n 完整

## 6. 阶段 d：FilterPanel 拆分

### 6.1 目录结构

```
src/components/FilterPanel/
├── index.tsx                  // 编排（Tabs 骨架 + Dialog）≤ 150 行
├── HistogramSection.tsx       // 直方图区 + useHistogramSync hook 调用
├── WhiteBalanceSection.tsx    // wbMode/滴管/温度/色调
├── BasicAdjustSection.tsx     // 11 个 SliderRow（曝光/对比/亮度/...饱和度）
├── DetailSection.tsx          // 2 个 SliderRow（清晰度/锐化）
├── GrainSection.tsx           // 4 个 SliderRow
├── InfoTab.tsx                // 信息 Tab（含 InfoGroup/InfoRow 私有子组件）
├── SavePresetDialog.tsx       // 保存预设对话框
└── SideTabTrigger.tsx         // 侧边 Tab 触发器
```

HSL / Curves / WatermarkTab 已独立，本次不动。

### 6.2 拆分原则

- 每个 Section **自己 `useStore` 订阅需要的字段**（细化 selector，减少不必要的重渲染）
- `index.tsx` 不订阅具体 filter 字段，只编排 Tabs/Dialog/SideTabTrigger
- `SavePresetDialog` 自己管理 `saveName / saveCategoryId` 两个本地 state，通过 props 接收 `open/onOpenChange`
- `useHistogramSync` 从 `src/hooks/` 搬到 `src/components/FilterPanel/`（仅本目录使用）
- 保留所有现有注释与命名（CLAUDE.md §5.4）

### 6.3 兼容性

- `import { FilterPanel } from "@/components/FilterPanel"` 依赖 `FilterPanel/index.tsx` 的 `export function FilterPanel`
- 调用方零改动（`App.tsx` 等）
- 路径别名 `@/components/FilterPanel` 不变
- 删除旧 `src/components/FilterPanel.tsx`

### 6.4 验证

- `pnpm lint` 通过
- 每个文件行数实测 ≤ 200 行（`wc -l src/components/FilterPanel/*.tsx`）
- 手动验证全部交互：所有 Tab 切换、所有 Slider、白平衡滴管、保存预设对话框、信息 Tab、直方图刷新

## 7. 风险与回归点

1. **直方图 IPC 与预览 IPC 抢 spawn_blocking 池**：共用 `preview_sem` 可能导致预览延迟。如果出现，改为独立 `histogram_sem`（permit=2）。
2. **80ms throttle 仍可能压垮后端**：极端狂拖场景。后端 `histogram_token` 取消机制兜底，trailing-edge throttle 兜底。
3. **缓存命中率**：直方图请求与预览请求的 `cache_path` 一致，二者首次互相预热。
4. **拆 FilterPanel 时丢失功能**：必须人工跑一次完整交互回归（见 6.4）。
5. **luma 归一化方式**：若 luma 分布与 RGB 共用 maxVal，视觉效果会失衡——必须用 luma 自身 maxVal。

## 8. 不做的事（YAGNI）

- 通道切换（c3）：本次不做，仅显示叠加视图
- hover 信息条（c4）：本次不做
- ts-rs / specta 自动类型生成：本次不做，留作独立任务
- 后端独立 `histogram_sem`：默认共用，出问题再拆
- 把 HSL / Curves / WatermarkTab 也搬进 `FilterPanel/` 目录：保持现状

## 9. 文件改动清单

新增：
- `src-tauri/src/ipc/histogram.rs`
- `src/lib/filterIdentity.ts`
- `src/hooks/useHistogramSync.ts`（阶段 d 移到 `src/components/FilterPanel/`）
- `src/components/FilterPanel/index.tsx`
- `src/components/FilterPanel/HistogramSection.tsx`
- `src/components/FilterPanel/WhiteBalanceSection.tsx`
- `src/components/FilterPanel/BasicAdjustSection.tsx`
- `src/components/FilterPanel/DetailSection.tsx`
- `src/components/FilterPanel/GrainSection.tsx`
- `src/components/FilterPanel/InfoTab.tsx`
- `src/components/FilterPanel/SavePresetDialog.tsx`
- `src/components/FilterPanel/SideTabTrigger.tsx`

修改：
- `src-tauri/src/ipc/preview.rs`：`PreviewResult` 移除 `histogram`，加 `#[serde(rename_all)]`
- `src-tauri/src/lib.rs`：注册 `compute_histogram`
- `src-tauri/src/state.rs`：新增 `histogram_token`
- `src-tauri/src/processing/histogram.rs`：加 `#[serde(rename_all)]`、`total_pixels`、单元测试
- `src/types.ts`：`HistogramData` 加 `luma`、`totalPixels`；`PreviewResult` 移除 `histogram`
- `src/api.ts`：新增 `computeHistogram` 包装
- `src/components/PreviewPanel.tsx`：删除直方图相关代码、改用 `isIdentityFilter`
- `src/components/Histogram.tsx`：4 通道绘制 + 裁剪警告 + 图例
- `src/i18n/en.ts` 与 `src/i18n/zh.ts`：新增 5 条翻译键

删除：
- `src/components/FilterPanel.tsx`（拆分到目录后删除）

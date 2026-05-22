# Tone Curve Editor — Design Spec

**Date:** 2026-05-22  
**Branch:** feature/raw-3  
**Status:** Approved

---

## 1. 目标

在 FujiSim 中实现 Lightroom 风格的**点曲线（Point Curve）**工具，支持 RGB 主通道 + R/G/B 三个独立通道，前端 SVG 编辑器 + Rust 后端插值处理，全链路对接现有 pipeline。

---

## 2. 数据模型

### 2.1 前端 `src/types.ts`

新增两个类型：

```typescript
export type CurvePoint = { x: number; y: number }; // 均为 0..1

export type ToneCurvePoints = {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
};
```

`FilterSettings` 增加字段：

```typescript
tone_curve?: ToneCurvePoints | null;
```

空通道（`[]`）表示该通道使用恒等曲线，不做任何处理。

### 2.2 Rust `src-tauri/src/processing/pipeline.rs`

新增结构体（带 serde）：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurvePoint { pub x: f32, pub y: f32 }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ToneCurvePoints {
    pub rgb: Vec<CurvePoint>,
    pub r: Vec<CurvePoint>,
    pub g: Vec<CurvePoint>,
    pub b: Vec<CurvePoint>,
}
```

`FilterSettings` 增加字段：

```rust
#[serde(default)]
pub tone_curve: Option<ToneCurvePoints>,
```

---

## 3. Rust 后端

### 3.1 依赖

`src-tauri/Cargo.toml` 增加：

```toml
splines = "5.0.0"
```

### 3.2 `curves.rs` — `ToneCurve::from_points`

```rust
impl ToneCurve {
    pub fn from_points(points: &[CurvePoint]) -> Self {
        // 少于 2 个点 → 恒等曲线
        // 按 x 升序排序
        // 构造 splines::Spline<f32, f32>，使用 CatmullRom 插值
        // 采样 256 个均匀 x 值，得到 LUT
        // 每个输出值 clamp 到 [0.0, 1.0]
    }
}
```

端点处理：CatmullRom 需要至少 4 个点才能在两端正常插值；当点数不足时，自动在首尾各补一个"幽灵点"（与最近端点相同 y 值），保证曲线在端点处平滑。

### 3.3 `pipeline.rs` — 集成位置

在步骤 `[2]`（富士分通道曲线）之后，插入步骤 `[2b]`：

```
[2b] 用户点曲线（叠加在富士预设曲线之上）
  1. 若 tone_curve.rgb 非空 → 构建 RGB 主 LUT，同时作用于 r/g/b
  2. 若 tone_curve.r 非空  → 构建 R 通道 LUT，作用于 r
  3. 若 tone_curve.g 非空  → 构建 G 通道 LUT，作用于 g
  4. 若 tone_curve.b 非空  → 构建 B 通道 LUT，作用于 b
```

**性能关键：** 四条 `ToneCurve` 在像素循环**之前**一次性构建，循环内只调用 `apply()`。

### 3.4 `is_identity()` 更新

增加判断：

```rust
&& self.tone_curve.as_ref().map_or(true, |tc| {
    tc.rgb.is_empty() && tc.r.is_empty() && tc.g.is_empty() && tc.b.is_empty()
})
```

---

## 4. 前端曲线编辑器

### 4.1 组件：`src/components/CurvesEditor.tsx`

纯 SVG 实现，无额外前端依赖。

**视觉结构：**
- 200×200px SVG 画布
- 深色背景（`#1a1a1a`）
- 3×3 网格线（`#333`）
- 对角恒等参考线（`#444`，虚线）
- 平滑曲线路径（JS 端 Catmull-Rom 近似，仅用于视觉渲染）
- 可拖拽控制点（`r=5` 圆形，hover 时放大到 `r=7`）

**交互规则：**

| 操作 | 效果 |
|------|------|
| 点击曲线空白区域 | 添加控制点 |
| 拖拽控制点 | 移动（x/y clamp 到 0..1） |
| 双击控制点 | 删除（端点不可删） |
| 始终保留 | `(0,0)` 和 `(1,1)` 两个端点 |

**通道 Tab：**

| Tab | 颜色 | 说明 |
|-----|------|------|
| RGB | 白色 | 主通道，同时影响三个通道 |
| R | 红色 `#f87171` | 仅红通道 |
| G | 绿色 `#4ade80` | 仅绿通道 |
| B | 蓝色 `#60a5fa` | 仅蓝通道 |

### 4.2 集成位置

加入 `FilterPanel.tsx` 现有 `<Tabs>` 结构，新增一个 Tab（key: `"curves"`，显示名：`t("curves")` / "曲线"）。

### 4.3 Store 变更

`FilterSettings` 加 `tone_curve` 字段后，`setFilter`（patch 合并）无需改动。`DEFAULT_FILTER` 中 `tone_curve` 默认为 `null`。

---

## 5. 不在本次范围内

- 参数曲线（滑块模式）
- 曲线预设保存/加载
- 直方图叠加显示
- 曲线导入/导出

---

## 6. 文件变更清单

| 文件 | 变更类型 |
|------|----------|
| `src/types.ts` | 新增 `CurvePoint`、`ToneCurvePoints`，扩展 `FilterSettings` |
| `src/store.ts` | `DEFAULT_FILTER` 加 `tone_curve: null` |
| `src/components/CurvesEditor.tsx` | 新建 |
| `src/components/FilterPanel.tsx` | 新增曲线 Tab，引入 `CurvesEditor` |
| `src-tauri/Cargo.toml` | 新增 `splines = "5.0.0"` |
| `src-tauri/src/processing/curves.rs` | 新增 `ToneCurve::from_points` |
| `src-tauri/src/processing/pipeline.rs` | 新增 `CurvePoint`、`ToneCurvePoints`，扩展 `FilterSettings`，集成步骤 `[2b]` |

# HSL 色彩调节功能设计

## 概述

在侧栏新增 HSL tab，实现类似 Adobe Lightroom/ACR 的按色相范围分别调节色相、饱和度、明度的功能。8 个色相范围，软边界重叠权重，3 个子 tab 切换。

## 数据模型

### FilterSettings 新增 24 个字段

默认值全为 0（无调节）：

| 色相范围 | Hue 滑块 | Sat 滑块 | Lum 滑块 |
|---------|----------|----------|----------|
| 红 (Red) | `hsl_red_hue` (-180..180) | `hsl_red_sat` (-100..100) | `hsl_red_lum` (-100..100) |
| 橙 (Orange) | `hsl_orange_hue` | `hsl_orange_sat` | `hsl_orange_lum` |
| 黄 (Yellow) | `hsl_yellow_hue` | `hsl_yellow_sat` | `hsl_yellow_lum` |
| 绿 (Green) | `hsl_green_hue` | `hsl_green_sat` | `hsl_green_lum` |
| 浅蓝 (Aqua) | `hsl_aqua_hue` | `hsl_aqua_sat` | `hsl_aqua_lum` |
| 蓝 (Blue) | `hsl_blue_hue` | `hsl_blue_sat` | `hsl_blue_lum` |
| 紫 (Purple) | `hsl_purple_hue` | `hsl_purple_sat` | `hsl_purple_lum` |
| 品红 (Magenta) | `hsl_magenta_hue` | `hsl_magenta_sat` | `hsl_magenta_lum` |

### 色相范围定义

8 个中心色相值（度）：`[0, 45, 90, 135, 180, 225, 270, 315]`

### 软边界权重

- 高斯权重：`w_i = exp(-dist² / (2 * σ²))`，σ = 30°
- 色相距离处理环绕：`dist = min(|h - center_i|, 360 - |h - center_i|)`
- 归一化：最终权重除以权重总和

## 前端 UI

### Tab 布局

- 在 FilterPanel 侧栏新增 "hsl" tab（图标 `Palette`），位于 "adjust" 和 "watermark" 之间
- HSL tab 内部：3 个水平子 tab（色相 / 饱和度 / 明度），使用 Radix Tabs
- 每个子 tab 下 8 个滑块，按红/橙/黄/绿/浅蓝/蓝/紫/品红排列
- 每个滑块左侧显示色相范围的色块小圆点标识
- 复用现有 `SliderField` 组件，双击归零行为一致

### 状态流

与现有滑块一致：拖动 → `setFilter({ hsl_red_hue: value })` → Zustand store → 防抖 250ms → Tauri IPC → Rust pipeline → 返回预览

### i18n

在 `en.ts` 和 `zh.ts` 中补充：HSL tab 标签、子 tab 名称、8 个色相范围名称

## Rust 后端

### 新增模块 `hsl_adjust.rs`

核心函数 `apply_hsl_adjust(buf: &mut [f32], settings: &HslSettings)`：

1. 遍历每个像素，RGB→HSL（复用 `color.rs` 的 `rgb_to_hsl`/`hsl_to_rgb`）
2. 计算像素色相到 8 个中心的高斯权重（处理环绕）
3. 加权混合得到总色相偏移、饱和度缩放、明度偏移
4. 应用偏移后 HSL→RGB

### 管线集成

- 在 `pipeline.rs` 的 `process_image_cpu` 中，step [7]（Vibrance + Saturation）之后、step [9]（Fade）之前插入 HSL 调节
- 使用 `rayon::par_chunks_mut` 并行，与现有 per-pixel 步骤一致
- 24 个参数全为 0 时跳过（`is_identity` 快速路径）

### GPU 适配

- `FilterUniforms` 新增 24 个 f32 字段
- 在 `color_fused.wgsl` compute shader 中加入 HSL 调节步骤
- 8 个中心 + 24 个偏移量作为 uniform 传入

### is_identity 更新

Rust 和前端的 `is_identity` 检查都要加上 24 个新字段的判断

## 不做的事

- 不做多项式近似权重优化（后续版本考虑）
- 不做参数为 0 的色相范围跳过优化（后续版本考虑）
- 不做色彩轮/色彩选择器等高级 UI（仅滑块）

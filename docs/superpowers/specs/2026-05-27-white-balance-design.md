# 白平衡功能设计

## 概述

在调整(Adjust)标签下新增"白平衡"可折叠 Section，位于"基础"上方。支持色温/色调滑块调整、还原设置、自动白平衡、吸管取色校准。

## 方案决策

**复用现有 `wb_shift_r` / `wb_shift_b` 字段**，零 GPU/着色器改动。`wb_shift_b` 对应色温（蓝通道偏移），`wb_shift_r` 对应色调（红通道偏移），滑块范围 -100~100。

## UI 布局

```
▼ 白平衡 (Palette 图标)
  [还原设置] [自动] [吸管]
  色温 ──────────── 0     (wb_shift_b, -100~100)
  色调 ──────────── 0     (wb_shift_r, -100~100)
▼ 基础
  ...
```

### 按钮交互

- **还原设置**：将 `wb_shift_r` 和 `wb_shift_b` 重置为 0
- **自动**：调用后端 `auto_white_balance(asset_id)` 命令，返回 `(wb_shift_r, wb_shift_b)`，更新 store
- **吸管**：点击后进入取色模式，预览图光标变为十字，点击取色后计算色温/色调偏移并更新滑块，自动退出吸管模式

### 吸管模式

1. 点击吸管按钮 → store 设置 `eyedropperMode: 'white-balance'`
2. PreviewPanel 检测模式 → 添加 `cursor: crosshair`，监听 onClick
3. 点击获取相对坐标 → 调用 `eyedrop_color(asset_id, x, y)` 获取 RGB
4. 前端以该点应为中性灰为假设计算偏移 → setFilter 更新 → 退出吸管模式

**吸管偏移计算公式**（前端）：
```
avg = (R + G + B) / 3
wb_shift_r = clamp((avg - R) / avg * 100, -100, 100)  // R 偏高 → 负向补偿
wb_shift_b = clamp((avg - B) / avg * 100, -100, 100)  // B 偏高 → 负向补偿
```

## 后端实现

### 自动白平衡

- 新增 Tauri 命令 `auto_white_balance(asset_id: String) -> (f32, f32)`
- 算法：灰度世界假设（Gray World），计算全图 R/G/B 均值，以 G 为基准，映射 R/B 偏移到 -100~100
- 新增模块 `src-tauri/src/processing/white_balance.rs`

### 吸管取色

- 新增 Tauri 命令 `eyedrop_color(asset_id: String, x: u32, y: u32) -> (f32, f32, f32)` 返回 RGB
- 从当前预览图像读取指定像素 RGB
- 前端计算偏移：R 偏高 → wb_shift_r 负向补偿，B 偏高 → wb_shift_b 负向补偿

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `src/store/types.ts` | 新增 `eyedropperMode` 和 `setEyedropperMode` |
| `src/store/slices/filter.ts` | 实现 eyedropperMode 状态 |
| `src/store/defaults.ts` | 新增 `eyedropperMode: 'none'` 默认值 |
| `src/components/FilterPanel.tsx` | 新增白平衡 Section（按钮组 + 滑块），位于基础上方 |
| `src/components/PreviewPanel.tsx` | 吸管模式交互（cursor + onClick 取色） |
| `src/i18n/zh.ts` | 新增白平衡相关 i18n 键 |
| `src/i18n/en.ts` | 新增白平衡相关 i18n 键 |
| `src-tauri/src/processing/mod.rs` | 注册 white_balance 模块 |
| `src-tauri/src/processing/white_balance.rs` | 新增：自动白平衡 + 吸管取色 |
| `src-tauri/src/commands/` | 新增 auto_white_balance 和 eyedrop_color Tauri 命令 |

### 不需要改动

GPU uniforms、着色器、CPU 管线（复用现有 wb_shift_r/b）

## i18n 新增键

| 键 | 中文 | 英文 |
|----|------|------|
| `editor.sections.whiteBalance` | 白平衡 | White Balance |
| `filterPanel.temperature` | 色温 | Temperature |
| `filterPanel.tint` | 色调 | Tint |
| `filterPanel.wbReset` | 还原设置 | Reset |
| `filterPanel.wbAuto` | 自动 | Auto |

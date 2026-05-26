# 颗粒效果重构设计

## 概述

将"效果"区域重命名为"颗粒"，从2个离散下拉菜单改为4个连续值滑块的可折叠分组。

## 前端 UI

Section 标题："颗粒"，`defaultOpen={false}`，内含 4 个 SliderRow：

| 滑块 | 字段名 | 范围 | 步进 | 默认值 |
|---|---|---|---|---|
| 颗粒效果 | `grain_amount` | 0-100 | 1 | 0 |
| 颗粒大小 | `grain_size` | 0-100 | 1 | 0 |
| 粗糙程度 | `grain_roughness` | 0-100 | 1 | 0 |
| 颗粒色彩 | `grain_color` | 0-100 | 1 | 0 |

所有参数为 0 时无效果。

## 后端算法

删除 `GrainStrength` 和 `GrainSize` 枚举，`apply_grain()` 改为接收 4 个 f32：

- **amount (0-100)**：振幅 = `amount / 100.0 * 0.06`
- **size (0-100)**：cell = `1 + (size / 100.0 * 7.0)`，范围 1-8
- **roughness (0-100)**：用第二层低频噪声调制振幅。调制 cell = base_cell × 4，scale = `1.0 + roughness / 100.0 * 2.0`
- **color (0-100)**：channel_independence = `color / 100.0`。对每个通道独立生成 delta，与共享 delta 混合：`final_delta = shared * (1 - indep) + channel * indep`

GPU shader 同步修改，uniform params 扩展。

## 数据迁移

SQLite 预设字段迁移：
- `grain_effect` → `grain_amount`：None→0, Weak→25, Medium→50, Strong→75
- `grain_size` → `grain_size`（新数值）：Small→0, Large→50
- 新增 `grain_roughness` → 默认 0
- 新增 `grain_color` → 默认 0

## 影响文件

| 层 | 文件 | 变更 |
|---|---|---|
| Rust 算法 | grain.rs | 重写 apply_grain |
| Rust GPU | grain.wgsl, gpu/passes/grain.rs | 扩展 params 和 shader |
| Rust 流水线 | pipeline.rs | 更新 FilterSettings 和调用 |
| Rust 数据库 | presets.rs | 迁移字段 |
| TS 类型 | types.ts | 替换字段 |
| TS 状态 | store/defaults.ts, slices/filter.ts | 更新字段和默认值 |
| TS UI | FilterPanel.tsx | Select → SliderRow |
| i18n | en.ts, zh.ts | 更新翻译 |

---
name: editor-page-redesign
description: 项目编辑页重构 — 四区域布局（左预设栏 / 中预览+顶栏+缩略图带 / 右分节折叠面板）
metadata:
  type: project
---

# 项目编辑页重构设计

## 背景

参考 Lightroom / Capture One 风格的修图工作台，重新组织 EditorPage 的布局与视觉。**仅做布局/视觉重构**，不新增任何后端能力，不实现截图里出现的人像美化、液化、AI 等额外功能。

## 整体布局

```
┌────────────────────────────────────────────────────────────┐
│ TitleBar（已有，不变）                                       │
├────────┬──────────────────────────────────┬────────────────┤
│        │ [EditorToolbar]                   │                │
│        │                                  │                │
│ Preset │      PreviewPanel                 │  FilterPanel   │
│ List   │      （预览区）                    │  分节折叠       │
│ ~220px │                                  │  ~340px        │
│        ├──────────────────────────────────┤                │
│        │ AssetStrip ~100px 高横向缩略图带   │                │
└────────┴──────────────────────────────────┴────────────────┘
```

- 左栏 `w-[220px]`，右栏 `w-[340px]`，中间 `flex-1`
- 中间内部纵向：顶栏 `h-10` + 预览区 `flex-1` + 缩略图带 `h-[100px]`

## 组件清单

| 组件 | 路径 | 职责 |
|---|---|---|
| `EditorPage` | `src/pages/EditorPage.tsx` | 拼装四区域；持有 `showOriginal` 局部状态 |
| `PresetList` | `src/components/Editor/PresetList.tsx` | 左栏预设列表（Tab 内置/我的 + 搜索 + 卡片） |
| `EditorToolbar` | `src/components/Editor/EditorToolbar.tsx` | 顶栏：重置效果 + 显示原图 + 导出 |
| `AssetStrip` | `src/components/Editor/AssetStrip.tsx` | 底部横向缩略图带 + 顶部小工具栏 |
| `FilterPanel`（重构） | `src/components/FilterPanel.tsx` | 去 Tabs，改为分节折叠 |
| `Section` | `src/components/ui/section.tsx` | 通用可折叠分节（FilterPanel 内复用） |
| `PreviewPanel` | `src/components/PreviewPanel.tsx` | 不动；`showOriginal` 改为 prop |

**删除**：`src/components/AssetList/` 整个目录（被 AssetStrip 替代）。`src/components/Sidebar.tsx` 若不再被引用一并删除。

## 数据流

不新增 store 字段，不增加后端 IPC。所有组件复用现有 store：

| 组件 | 读取 | 调用 |
|---|---|---|
| `PresetList` | `presets`、`filter` | `applyPreset(preset)`、`refreshPresets()` |
| `EditorToolbar` | `filter`、`focusedId` | `resetFilter()`；`showOriginal` 经 prop |
| `AssetStrip` | `assets`、`selectedIds`、`focusedId`、`totalCount`、`query` | `toggleSelect`、`selectRange`、`focusAsset`、`setQuery` |
| `FilterPanel` | `filter`、`watermark`、`assets`、`focusedId` | `setFilter`、`setWatermark`、其余保持原状 |

**`showOriginal` 状态提升**：从 `PreviewPanel` 内部移到 `EditorPage` 局部 `useState`，作为 prop 同时传给 `PreviewPanel` 和 `EditorToolbar`。**不进 store**。

## 各区域细节

### EditorToolbar（顶栏）

- 左侧按钮：
  - **重置效果**：点击直接调 `resetFilter()`，无确认弹框
  - **显示原图**：单击 toggle `showOriginal`
- 右侧：导出按钮（替代现 PreviewPanel 内的导出入口）
- `focusedId` 为 null 时左侧按钮 disabled
- 风格：`h-10` 横条，深色背景，与 TitleBar 视觉一致

### PresetList（左栏）

- 顶部：返回按钮（← 回 `/projects`） + 项目名
- 中部 Tabs：`推荐 / 我的`（`is_builtin === 1` vs 0）
- 搜索框：本地 `useState` 名字过滤
- 卡片列表：每张显示预设名 + 当前选中态高亮（filter 完全匹配预设时高亮，简化判断：`filter.base_simulation === preset.base_simulation`）
- 点击卡片：`applyPreset(preset)`

### AssetStrip（底部）

- 顶部小工具栏（`h-8`）：星级筛选下拉（绑定 `query.min_rating`）+ `focused asset` 文件名 + `已选 N / 共 M` + 单视图/对比视图按钮（**对比视图仅占位**）
- 横向滚动区：每张 `w-20 h-20`（80×80），间距 8px
- 选中态：`ring-2 ring-blue-500`
- 点击切换 `focusedId`；Cmd/Ctrl 多选；Shift 区间选（沿用 store action）
- 鼠标滚轮：垂直滚 → 横向滚（`onWheel` 转 `scrollLeft`）
- 空文件夹：显示提示 + 导入按钮（复用现有导入逻辑）

### FilterPanel（分节折叠）

去掉 Tabs，改为纵向滚动 + 多个可折叠 `<Section>`：

| 分节 | 默认状态 | 内容 |
|---|---|---|
| **基础** | 展开 | 胶片模拟选择 + LUT 导入 |
| **光线** | 展开 | highlight_tone、shadow_tone |
| **色彩** | 展开 | color_saturation、color_chrome_effect、wb_shift_r、wb_shift_b |
| **效果** | 展开 | grain_effect、grain_size、clarity |
| **细节** | 展开 | sharpness |
| **曲线** | 折叠 | CurvesEditor |
| **水印** | 折叠 | WatermarkTab 现有内容（去掉外层 TabsContent 包装） |
| **信息** | 折叠 | 文件元数据（现 info tab 内容） |

折叠状态用 FilterPanel 内 `useState<Record<string, boolean>>` 维护，不持久化。

**预设管理移走**：原 FilterPanel 里的 "Preset" tab 整体被 PresetList 取代，删除。

### Section 通用组件

```tsx
interface SectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}
```

- 标题栏可点击：左侧标题文字 + 右侧箭头图标（开/关时旋转 90°）
- 折叠时不渲染 children（unmount），避免不必要的副作用

## i18n 新增键（中英对照）

```ts
editor: {
  reset: "重置效果" / "Reset",
  showOriginal: "显示原图" / "Show Original",
  export: "导出" / "Export",
  noFocused: "未选中图片" / "No image selected",
  emptyFolder: "该文件夹为空" / "This folder is empty",
  import: "导入" / "Import",
  presetList: {
    builtin: "推荐" / "Recommended",
    mine: "我的" / "Mine",
    searchPlaceholder: "搜索预设" / "Search presets",
  },
  strip: {
    selectedCountOfTotal: "已选 {{n}} / 共 {{m}}" / "{{n}} of {{m}}",
    single: "单视图" / "Single",
    compare: "对比视图" / "Compare",
  },
  sections: {
    basic: "基础" / "Basic",
    light: "光线" / "Light",
    color: "色彩" / "Color",
    effects: "效果" / "Effects",
    detail: "细节" / "Detail",
    curves: "曲线" / "Curves",
    watermark: "水印" / "Watermark",
    info: "信息" / "Info",
  },
},
```

## 不做（明确划线）

- 不实现截图里的人像美化、AI 色彩、液化、修补、智能消除、仿制图章、污点修复等
- 不增加新的后端 IPC
- 「对比视图」按钮仅占位，无实际逻辑
- 不增加键盘快捷键（左右切图等可后续做）
- 不持久化分节展开状态

## 约束

- 单文件不超过 500 行，超出则继续拆分
- 不破坏现有 store/api 行为，所有现有 action 名称保持
- 视觉风格沿用 `zinc-950 / zinc-800 / blue-500`（蓝色主题色）

# SVG 水印重构设计

## 概述

将现有前端 Canvas 预渲染 PNG 水印层替换为 SVG-first 水印系统。预览直接渲染 SVG；导出只持久化和传递水印设置，由 Rust 在目标导出尺寸上渲染 SVG 并合成到最终图片。PNG 水印层、base64 传输、按任务保存 PNG 文件的旧链路不再保留。

## 目标

- 水印预览和导出都以 SVG 为语义源，避免预览尺寸 PNG 被缩放造成模糊或形变。
- 水印导出可从 `watermark_json` 独立恢复，重试任务不再依赖前端重新渲染水印层。
- Watermark Tab 新增推荐列表和自定义列表，所有条目显示 SVG 缩略图。
- 支持导入 SVG 文件，并允许第一版编辑 SVG 的统一颜色、内部文本、透明度、缩放、旋转、翻转和位置。

## 非目标

- 不做 SVG path 形状编辑。
- 不支持脚本、动画、外链资源、`foreignObject`。
- 不保证复杂 SVG filter 与浏览器预览 100% 一致；第一版面向 logo、签名、文字、简单图形类水印。
- 不继续兼容前端生成 PNG 水印层的导出接口。

## 数据模型

### WatermarkSettings

`WatermarkSettings` 从纯文字配置扩展为 SVG 水印配置，保留通用定位和变换字段：

```ts
type WatermarkKind = "text" | "svg";
type WatermarkSource = "builtin" | "imported" | "preset";

type WatermarkSettings = {
  enabled: boolean;
  kind: WatermarkKind;
  source: WatermarkSource;
  name?: string;

  text: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  bold: boolean;
  italic: boolean;
  italicDegree: number;
  strokeEnabled: boolean;
  strokeColor: string;
  strokeWidth: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;

  svgId?: number;
  svgTextOverride?: string;
  svgFillOverride?: string;
  svgStrokeOverride?: string;
  svgOriginalViewBox?: string;

  opacity: number;
  scale: number;
  position: WatermarkPosition;
  offsetX: number;
  offsetY: number;
  nudgeStep: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
};
```

说明：

- `kind: "text"` 使用文字参数生成 SVG。
- `kind: "svg"` 使用导入 SVG，应用统一覆盖色和文本覆盖。
- `scale` 是 SVG 水印相对推荐尺寸的倍率，用来替代旧方案中隐含的 canvas scale。
- 旧 `watermark_presets.settings_json` 继续保存完整 `WatermarkSettings`，但新保存的预设写入新版字段。

### 导入 SVG 表

新增 `user_watermark_svgs`：

| 字段 | 说明 |
|------|------|
| `id` | 主键 |
| `name` | 展示名 |
| `file_path` | 复制到应用数据目录 `watermark_svgs/` 下的 SVG 文件 |
| `preview_svg` | 清洗后的缩略图 SVG 字符串，可为空；为空时从文件读取 |
| `created_at` | 创建时间 |
| `is_deleted` / `deleted_at` | 软删除 |

应用数据目录新增 `watermark_svgs/`。清空应用数据时同步清理该目录和表记录。

## SVG 处理规则

### 清洗

导入 SVG 时执行清洗：

- 拒绝或移除 `<script>`、`<foreignObject>`、动画标签、事件属性、外链 `href`、远程图片。
- 保留静态图形、`path`、`text`、`g`、`defs`、`linearGradient`、`radialGradient`、基础样式。
- 记录或推断 `viewBox`；没有 `viewBox` 时用 `width/height` 补齐。

### 统一改色

第一版使用统一覆盖策略：

- 用户选择填充色时，覆盖可编辑元素的 `fill` 和 `currentColor`。
- 用户选择描边色时，覆盖可编辑元素的 `stroke`。
- `fill="none"` 和 `stroke="none"` 保持不变。
- 若 SVG 使用 CSS class 设置颜色，清洗/渲染阶段应以内联覆盖优先。

### 文本编辑

- 若导入 SVG 内含 `<text>`，Watermark Tab 显示文本输入框。
- 第一版统一替换所有 `<text>` 的文本内容。
- 没有 `<text>` 的 SVG 不显示文本编辑项。

## 前端设计

### Watermark Tab

布局从单个下拉预设调整为列表式：

1. 顶部：启用水印开关。
2. 推荐列表：系统预设卡片网格，每张卡展示 SVG 缩略图和名称。
3. 自定义列表：包含“导入 SVG”按钮、导入 SVG 卡片、用户保存的水印预设卡片。
4. 编辑区：根据当前水印类型显示对应控件。

文字水印编辑：

- 文本、字体、字号、粗体、斜体、颜色、透明度、描边、阴影、位置、缩放、旋转、翻转。

SVG 水印编辑：

- SVG 内部文本（如果存在）、统一填充色、统一描边色、透明度、缩放、位置、旋转、翻转。

### 推荐列表

系统推荐样式由前端常量定义，包含：

- 名称和 i18n key。
- `WatermarkSettings` 补丁。
- 缩略图 SVG，由同一套 `buildWatermarkSvg()` 生成。

点击推荐卡片时：

- 设置 `enabled: true`。
- 应用推荐样式。
- 清空自定义预设选中态。

### 自定义列表

自定义列表展示：

- 用户保存的水印预设：从 `watermark_presets` 读取 `settings_json` 生成缩略图。
- 用户导入 SVG：从 `user_watermark_svgs` 读取清洗后的 SVG 生成缩略图。

导入 SVG：

- 使用 Tauri dialog 选择 `.svg`。
- 调用后端 `import_watermark_svgs(paths)`。
- 后端复制文件、清洗、写入 DB。
- 前端刷新列表并应用新导入项。

### 预览覆盖层

`WatermarkOverlay` 改为直接渲染 SVG：

- 通过 `buildWatermarkSvg(wm, imgW, imgH)` 生成完整画布 SVG。
- 使用内联 `<svg>` 或 `data:image/svg+xml` 展示。
- 位置、透明度、缩放、旋转、翻转由 SVG 内部 transform 表达，避免 CSS 预览和导出算法分叉。

删除旧 `renderWatermarkLayer()` 的预览调用。`src/lib/watermarkCanvas.ts` 后续可删除。

## 导出设计

### IPC

`start_batch_export` 请求删除 `per_asset_watermark`：

```ts
startBatchExport({
  asset_ids,
  filter,
  export,
  watermark_settings: watermark.enabled ? watermark : null,
});
```

`retry_export_task` 删除 `watermarkLayer` 参数，直接复用 DB 中的 `watermark_json`。

### Rust 渲染

后端在导出任务执行时：

1. 从 `batch_tasks.watermark_json` 解析 `WatermarkSettings`。
2. 根据最终导出尺寸生成完整画布 SVG。
3. 使用 SVG rasterizer 渲染到 RGBA。
4. 复用现有 alpha composite 合成到 `RgbImage`。

建议依赖：

- `resvg` / `usvg` / `tiny-skia` 用于 SVG 解析与栅格化。
- 后端字体数据库需要加载系统字体和 `user_fonts.file_path` 中的用户字体。

### 字体

文字水印导出需要后端字体加载：

- 内置字体栈优先匹配系统字体。
- 用户导入字体继续使用现有 `user_fonts` 表；`fontFamilyName(id)` 对应的字体文件路径需要传达或由后端查询。
- 若字体缺失，后端回退到默认 sans-serif，并记录 warning。

## 旧链路移除

需要移除或废弃：

- 前端 `renderWatermarkLayer()` 生成 PNG。
- `ExportDialog` 中逐 asset 生成 `perAssetWatermark`。
- API 中 `per_asset_watermark` 和 `retryExportTask(..., watermarkLayer)`。
- Rust `WatermarkLayer`、`save_watermark_layer()`、`load_watermark()`、`watermark_layer_path` 的新任务写入。
- `<data_dir>/watermarks/<task_id>.png` 的依赖。

DB 字段 `batch_tasks.watermark_layer_path` 可以先保留但不再写入，避免一次性迁移风险。后续清理数据库迁移时再移除。

## 错误处理

- 导入非法 SVG：跳过该文件并返回可展示错误。
- 导出 SVG 渲染失败：记录 warning，跳过该任务水印，导出图片继续完成。
- 字体缺失：回退默认字体并继续导出。
- SVG 无尺寸信息且无法推断 viewBox：导入失败。

## 测试与验证

- 前端单元：`buildWatermarkSvg()` 对文字、位置、缩放、旋转、SVG 改色、文本覆盖生成稳定输出。
- 后端单元：SVG 清洗、导入文件复制、非法标签过滤、无 viewBox 处理。
- 导出集成：不同宽高比、不同导出 resize、重试任务水印恢复。
- UI 验证：推荐列表、自定义列表、导入 SVG、删除、保存预设、缩略图渲染。
- 回归验证：无水印导出不受影响；旧水印预设尽量按默认文字水印字段迁移显示。

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `src/types.ts` | 扩展 `WatermarkSettings`，新增导入 SVG 类型 |
| `src/store/types.ts` | 扩展 Watermark slice，新增 SVG 列表 action |
| `src/store/slices/watermark.ts` | 应用推荐、导入 SVG、保存预设兼容新版设置 |
| `src/api.ts` | 删除 PNG 水印层参数，新增 SVG 导入/list/delete API |
| `src/lib/watermarkSvg.ts` | 新增 SVG 生成、覆盖色、缩略图工具 |
| `src/lib/watermarkCanvas.ts` | 删除或停止使用 |
| `src/components/preview/WatermarkOverlay.tsx` | 改为 SVG overlay |
| `src/components/WatermarkTab.tsx` | 推荐列表、自定义列表、SVG 编辑控件 |
| `src/components/ExportDialog.tsx` | 删除 per-asset PNG 渲染，直接传设置 |
| `src/i18n/zh.ts` / `src/i18n/en.ts` | 新增推荐、自定义、导入 SVG、SVG 编辑文案 |
| `src-tauri/src/db/mod.rs` | 新增 `user_watermark_svgs` 表 |
| `src-tauri/src/db/watermark_svgs.rs` | 新增导入 SVG CRUD |
| `src-tauri/src/ipc/watermark.rs` | 新增 SVG 导入/list/delete IPC |
| `src-tauri/src/export/mod.rs` | 删除 PNG layer 合成入口，新增 SVG 设置渲染入口 |
| `src-tauri/src/ipc/export.rs` | 删除 `per_asset_watermark` 和重试 layer 参数 |
| `src-tauri/src/vips_io.rs` | 删除或停止使用 `load_watermark()` |
| `src-tauri/Cargo.toml` | 新增 SVG rasterizer 相关依赖 |


# 水印文字描边功能设计

## 概述

为水印文字新增描边（stroke）功能，支持独立颜色控制和粗细调节，与现有阴影功能并存且互不干扰。

## 类型变更（`src/types.ts`）

在 `WatermarkSettings` 类型末尾追加三个字段：

```ts
strokeEnabled: boolean;
strokeColor: string;   // hex 颜色，独立于填充色和阴影色
strokeWidth: number;   // 描边粗细，单位 px，范围 1–10
```

在 `DEFAULT_WATERMARK` 追加对应默认值：

```ts
strokeEnabled: false,
strokeColor: "#000000",
strokeWidth: 2,
```

## 渲染变更（`src/lib/watermarkCanvas.ts`）

替换现有的阴影 + fillText 逻辑，改为：

1. **只开描边，不开阴影**：`strokeText` → `fillText`，无阴影。
2. **只开阴影，不开描边**：行为与现在完全相同，`fillText` 前设置 shadow。
3. **描边 + 阴影同时开启**：阴影挂在 `strokeText` 上，`strokeText` 后清除 `shadowColor = "transparent"`，再 `fillText`。阴影从描边边缘向外扩散，视觉最自然，且阴影只绘制一次。
4. **均关闭**：直接 `fillText`，无额外操作。

描边样式：
- `strokeStyle = colorWithAlpha(wm.strokeColor, wm.opacity)`（opacity 预乘，与填充色逻辑一致）
- `lineWidth = wm.strokeWidth * scale`
- `lineJoin = "round"`（避免尖角溢出）

绘制顺序：先 `strokeText`，后 `fillText`，确保描边在填充色下方不遮盖填充。

## UI 变更（`src/components/WatermarkTab.tsx`）

在阴影区块（`wm.shadowEnabled` 区块）之后、位置区块之前，新增描边区块，结构与阴影区块完全一致：

```
[开关] 描边
  └─ strokeEnabled = true 时展开：
       颜色选择器 + hex 输入框  →  strokeColor
       滑块 1–10px              →  strokeWidth
```

无需新图标，与阴影区块共用同一视觉语言。

## i18n 变更

`src/i18n/zh.ts` 和 `src/i18n/en.ts` 各在 `watermark` 节点下追加：

| key | zh | en |
|-----|----|----|
| `stroke` | 描边 | Stroke |
| `strokeColor` | 描边色 | Stroke Color |
| `strokeWidth` | 描边粗细 | Stroke Width |

## 数据兼容性

新字段有默认值，旧存档（不含描边字段）读取时由 store 的 merge 逻辑补全默认值，无需迁移。

## 不在范围内

- 描边不单独控制透明度（与填充色共用 `opacity`，行为一致）
- 不支持描边与填充色混合模式

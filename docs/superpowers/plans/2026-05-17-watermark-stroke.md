# Watermark Stroke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为水印文字新增描边功能，支持独立颜色和粗细控制，与阴影功能兼容共存。

**Architecture:** 在 `WatermarkSettings` 类型加三个字段；渲染层 `watermarkCanvas.ts` 根据开关组合处理描边/阴影绘制顺序；UI 层 `WatermarkTab.tsx` 在阴影区块后增加描边区块；中英文 i18n 各加三个 key。

**Tech Stack:** TypeScript, React, Canvas 2D API, i18next

---

### Task 1: 类型与默认值

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: 在 `WatermarkSettings` 类型末尾追加三个字段**

在 [src/types.ts:237](src/types.ts#L237)（`bold: boolean;` 之后、`};` 之前）插入：

```ts
  strokeEnabled: boolean;
  strokeColor: string;
  strokeWidth: number;
```

完整 `WatermarkSettings` 末尾应为：
```ts
  bold: boolean;
  strokeEnabled: boolean;
  strokeColor: string;
  strokeWidth: number;
};
```

- [ ] **Step 2: 在 `DEFAULT_WATERMARK` 追加默认值**

在 [src/types.ts:261](src/types.ts#L261)（`bold: false,` 之后、`};` 之前）插入：

```ts
  strokeEnabled: false,
  strokeColor: "#000000",
  strokeWidth: 2,
```

- [ ] **Step 3: 确认 TypeScript 编译无报错**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -30
```

预期：无输出（无错误）。

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add stroke fields to WatermarkSettings type"
```

---

### Task 2: 渲染逻辑

**Files:**
- Modify: `src/lib/watermarkCanvas.ts`

- [ ] **Step 1: 替换阴影+绘制区块**

当前 [src/lib/watermarkCanvas.ts:82-121](src/lib/watermarkCanvas.ts#L82-L121) 的阴影设置和绘制逻辑替换为以下内容（从 `if (wm.shadowEnabled)` 到 `octx.fillText(...)` 整段替换）：

```ts
  if (wm.strokeEnabled) {
    octx.strokeStyle = colorWithAlpha(wm.strokeColor, wm.opacity);
    octx.lineWidth = wm.strokeWidth * scale;
    octx.lineJoin = "round";
    if (wm.shadowEnabled) {
      octx.shadowColor = colorWithAlpha(wm.shadowColor, wm.opacity);
      octx.shadowBlur = (wm.shadowBlur / 2) * scale;
      octx.shadowOffsetX = wm.shadowOffsetX * scale;
      octx.shadowOffsetY = wm.shadowOffsetY * scale;
    }
    octx.strokeText(wm.text, ax, ay + baseline);
    octx.shadowColor = "transparent";
    octx.shadowBlur = 0;
    octx.shadowOffsetX = 0;
    octx.shadowOffsetY = 0;
  } else if (wm.shadowEnabled) {
    octx.shadowColor = colorWithAlpha(wm.shadowColor, wm.opacity);
    octx.shadowBlur = (wm.shadowBlur / 2) * scale;
    octx.shadowOffsetX = wm.shadowOffsetX * scale;
    octx.shadowOffsetY = wm.shadowOffsetY * scale;
  }
  octx.fillText(wm.text, ax, ay + baseline);
```

完整替换后 `octx.save()` 到 `octx.restore()` 之间应为：

```ts
  octx.save();
  octx.translate(cx, cy);
  if (wm.rotation !== 0) octx.rotate((wm.rotation * Math.PI) / 180);
  octx.scale(wm.flipH ? -1 : 1, wm.flipV ? -1 : 1);
  if (wm.italic) octx.transform(1, 0, Math.tan((-wm.italicDegree * Math.PI) / 180), 1, 0, 0);
  octx.translate(-cx, -cy);

  const baseline =
    metrics.actualBoundingBoxAscent !== undefined
      ? metrics.actualBoundingBoxAscent
      : wm.fontSize * scale * 0.8;

  if (wm.strokeEnabled) {
    octx.strokeStyle = colorWithAlpha(wm.strokeColor, wm.opacity);
    octx.lineWidth = wm.strokeWidth * scale;
    octx.lineJoin = "round";
    if (wm.shadowEnabled) {
      octx.shadowColor = colorWithAlpha(wm.shadowColor, wm.opacity);
      octx.shadowBlur = (wm.shadowBlur / 2) * scale;
      octx.shadowOffsetX = wm.shadowOffsetX * scale;
      octx.shadowOffsetY = wm.shadowOffsetY * scale;
    }
    octx.strokeText(wm.text, ax, ay + baseline);
    octx.shadowColor = "transparent";
    octx.shadowBlur = 0;
    octx.shadowOffsetX = 0;
    octx.shadowOffsetY = 0;
  } else if (wm.shadowEnabled) {
    octx.shadowColor = colorWithAlpha(wm.shadowColor, wm.opacity);
    octx.shadowBlur = (wm.shadowBlur / 2) * scale;
    octx.shadowOffsetX = wm.shadowOffsetX * scale;
    octx.shadowOffsetY = wm.shadowOffsetY * scale;
  }
  octx.fillText(wm.text, ax, ay + baseline);
  octx.restore();
```

- [ ] **Step 2: 确认 TypeScript 编译无报错**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -30
```

预期：无输出。

- [ ] **Step 3: Commit**

```bash
git add src/lib/watermarkCanvas.ts
git commit -m "feat: implement stroke rendering in watermarkCanvas"
```

---

### Task 3: i18n

**Files:**
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 1: 在 zh.ts 的 watermark 节点追加描边 key**

在 [src/i18n/zh.ts](src/i18n/zh.ts) `offsetY: "偏移 Y",` 之后、`position:` 之前插入：

```ts
    stroke: "描边",
    strokeColor: "描边色",
    strokeWidth: "描边粗细",
```

- [ ] **Step 2: 在 en.ts 的 watermark 节点追加描边 key**

在 [src/i18n/en.ts](src/i18n/en.ts) `offsetY: "Offset Y",` 之后、`position:` 之前插入：

```ts
    stroke: "Stroke",
    strokeColor: "Stroke color",
    strokeWidth: "Stroke width",
```

- [ ] **Step 3: 确认 TypeScript 编译无报错**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -30
```

预期：无输出。

- [ ] **Step 4: Commit**

```bash
git add src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat: add stroke i18n keys for zh and en"
```

---

### Task 4: UI 控件

**Files:**
- Modify: `src/components/WatermarkTab.tsx`

- [ ] **Step 1: 在阴影区块之后、位置区块之前插入描边区块**

在 [src/components/WatermarkTab.tsx](src/components/WatermarkTab.tsx) 阴影区块结束（`</div>` 对应 `{wm.shadowEnabled && ...}` 外层 `div`）之后，定位到以下内容：

```tsx
      <div>
        <Label>{t("watermark.position")}</Label>
```

在这一行**之前**插入：

```tsx
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-300">{t("watermark.stroke")}</span>
          <ToggleSwitch checked={wm.strokeEnabled} onChange={(v) => setWatermark({ strokeEnabled: v })} />
        </div>
        {wm.strokeEnabled && (
          <div className="space-y-2 pl-2 border-l border-zinc-800">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400 w-12 shrink-0">{t("watermark.strokeColor")}</span>
              <input type="color" value={wm.strokeColor} onChange={(e) => setWatermark({ strokeColor: e.target.value })} className="h-6 w-8 rounded border border-zinc-700 bg-transparent cursor-pointer" />
              <Input value={wm.strokeColor} onChange={(e) => setWatermark({ strokeColor: e.target.value })} className="h-6 text-xs flex-1 font-mono" maxLength={7} />
            </div>
            <SliderRow label={t("watermark.strokeWidth")} value={wm.strokeWidth} min={1} max={10} step={0.5} onChange={(v) => setWatermark({ strokeWidth: v })} display={(v) => `${v}px`} />
          </div>
        )}
      </div>
```

- [ ] **Step 2: 确认 TypeScript 编译无报错**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -30
```

预期：无输出。

- [ ] **Step 3: Commit**

```bash
git add src/components/WatermarkTab.tsx
git commit -m "feat: add stroke UI controls to WatermarkTab"
```

---

### Task 5: 手动验证

- [ ] **Step 1: 启动开发服务器**

```bash
cd /Users/ry2019/private/FujiSim && pnpm dev
```

- [ ] **Step 2: 验证以下场景**

1. **只开描边**：水印出现描边，无阴影。调整粗细（1–10px）和颜色均有效。
2. **只开阴影**：与修改前行为一致，阴影正常。
3. **描边 + 阴影同时开启**：阴影从描边边缘扩散，无双重阴影加重。
4. **均关闭**：纯文字，无描边无阴影。
5. **保存预设**：含描边设置的预设保存后可正确还原。
6. **旧存档兼容**：不含描边字段的存档读取后，描边默认关闭，不崩溃。

- [ ] **Step 3: 确认无视觉回归后停止开发服务器**

# Editor Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 EditorPage 成 4 区域布局：左预设栏 / 中预览+顶栏+缩略图带 / 右分节折叠面板，仅做布局视觉重构，不新增后端能力。

**Architecture:** 把现有 `FilterPanel` 拆为分节折叠（去 Tabs）；删除 `AssetList` 替换为底部横向 `AssetStrip`；新增左侧 `PresetList`、顶部 `EditorToolbar`；`PreviewPanel` 接收 `showOriginal` prop，由 `EditorPage` 提升状态。

**Tech Stack:** React 18, TypeScript, Tailwind CSS, react-i18next, Zustand store（不改），lucide-react

---

## 文件清单

### 新建
- `src/components/ui/section.tsx` — 通用可折叠分节
- `src/components/Editor/PresetList.tsx` — 左侧预设列表
- `src/components/Editor/EditorToolbar.tsx` — 顶部工具条
- `src/components/Editor/AssetStrip.tsx` — 底部横向缩略图带

### 修改
- `src/components/PreviewPanel.tsx` — `showOriginal` 改 prop
- `src/components/FilterPanel.tsx` — 去 Tabs，分节折叠重构
- `src/pages/EditorPage.tsx` — 拼装新布局
- `src/i18n/zh.ts`、`src/i18n/en.ts` — 新增 `editor.*` 键

### 删除
- `src/components/AssetList/` 整个目录
- `src/components/Sidebar.tsx`（重构后不再被引用时）

---

## Task 1: 通用可折叠 `Section` 组件

**Files:**
- Create: `src/components/ui/section.tsx`

- [ ] **Step 1: 创建 `Section` 组件**

```tsx
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function Section({ title, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-zinc-800/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-zinc-900/40 transition-colors"
      >
        <span className="text-xs uppercase tracking-wider text-zinc-300 font-semibold">{title}</span>
        <ChevronDown
          size={14}
          className={cn("text-zinc-500 transition-transform", open ? "rotate-0" : "-rotate-90")}
        />
      </button>
      {open && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 检查**

```bash
cd /Users/ry2019/private/FujiSim && pnpm build 2>&1 | grep "error TS"
```

Expected: 无 error。

- [ ] **Step 3: Commit**

```bash
cd /Users/ry2019/private/FujiSim && git add src/components/ui/section.tsx && git commit -m "feat(ui): add collapsible Section component"
```

---

## Task 2: i18n 新增 `editor.*` 键

**Files:**
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 1: 在 `src/i18n/zh.ts` 的 `projects` 节点之后追加 `editor` 节点**

```ts
  editor: {
    reset: "重置效果",
    showOriginal: "显示原图",
    hideOriginal: "显示效果",
    export: "导出",
    noFocused: "未选中图片",
    emptyFolder: "该文件夹为空",
    import: "导入",
    presetList: {
      builtin: "推荐",
      mine: "我的",
      searchPlaceholder: "搜索预设",
    },
    strip: {
      selectedCountOfTotal: "已选 {{n}} / 共 {{m}}",
      single: "单视图",
      compare: "对比视图",
    },
    sections: {
      basic: "基础",
      light: "光线",
      color: "色彩",
      effects: "效果",
      detail: "细节",
      curves: "曲线",
      watermark: "水印",
      info: "信息",
    },
  },
```

- [ ] **Step 2: 在 `src/i18n/en.ts` 同位置追加英文键**

```ts
  editor: {
    reset: "Reset",
    showOriginal: "Show Original",
    hideOriginal: "Show Edited",
    export: "Export",
    noFocused: "No image selected",
    emptyFolder: "This folder is empty",
    import: "Import",
    presetList: {
      builtin: "Recommended",
      mine: "Mine",
      searchPlaceholder: "Search presets",
    },
    strip: {
      selectedCountOfTotal: "{{n}} of {{m}}",
      single: "Single",
      compare: "Compare",
    },
    sections: {
      basic: "Basic",
      light: "Light",
      color: "Color",
      effects: "Effects",
      detail: "Detail",
      curves: "Curves",
      watermark: "Watermark",
      info: "Info",
    },
  },
```

- [ ] **Step 3: Commit**

```bash
cd /Users/ry2019/private/FujiSim && git add src/i18n/zh.ts src/i18n/en.ts && git commit -m "feat(i18n): add editor.* translation keys"
```

---

## Task 3: `PreviewPanel` 接收 `showOriginal` prop

**Files:**
- Modify: `src/components/PreviewPanel.tsx`

- [ ] **Step 1: 修改 PreviewPanel 签名**

找到顶部的函数签名和 useState：

```tsx
export function PreviewPanel({ onExport }: { onExport: () => void }) {
```

改为：

```tsx
interface PreviewPanelProps {
  onExport?: () => void;
  showOriginal: boolean;
  onShowOriginalChange?: (v: boolean) => void;
}

export function PreviewPanel({ onExport, showOriginal, onShowOriginalChange }: PreviewPanelProps) {
```

- [ ] **Step 2: 删除内部 `showOriginal` 局部状态**

找到这一行并删除：

```tsx
const [showOriginal, setShowOriginal] = useState(false);
```

把 PreviewPanel 内任何 `setShowOriginal(...)` 调用，改为 `onShowOriginalChange?.(...)`。

- [ ] **Step 3: TypeScript 检查**

```bash
pnpm build 2>&1 | grep "error TS"
```

Expected: 此时 EditorPage 仍按旧 API 调用，会有 1-2 个 TS error 提示缺 `showOriginal` prop，这是预期的。下一个 task 修复。

- [ ] **Step 4: Commit**

```bash
cd /Users/ry2019/private/FujiSim && git add src/components/PreviewPanel.tsx && git commit -m "refactor(preview): lift showOriginal to props"
```

---

## Task 4: `EditorToolbar` 顶栏

**Files:**
- Create: `src/components/Editor/EditorToolbar.tsx`

- [ ] **Step 1: 创建组件**

```tsx
import { RotateCcw, Eye, EyeOff, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { useTranslation } from "react-i18next";

interface EditorToolbarProps {
  showOriginal: boolean;
  onToggleShowOriginal: () => void;
  onExport: () => void;
}

export function EditorToolbar({ showOriginal, onToggleShowOriginal, onExport }: EditorToolbarProps) {
  const { t } = useTranslation();
  const focusedId = useStore((s) => s.focusedId);
  const resetFilter = useStore((s) => s.resetFilter);
  const disabled = focusedId == null;

  return (
    <div className="h-10 flex-shrink-0 flex items-center gap-2 px-3 border-b border-zinc-800/60 bg-zinc-950/50">
      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        disabled={disabled}
        onClick={() => resetFilter()}
        title={t("editor.reset")}
      >
        <RotateCcw size={13} />
        {t("editor.reset")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        disabled={disabled}
        onClick={onToggleShowOriginal}
      >
        {showOriginal ? <EyeOff size={13} /> : <Eye size={13} />}
        {showOriginal ? t("editor.hideOriginal") : t("editor.showOriginal")}
      </Button>

      <div className="ml-auto">
        <Button
          size="sm"
          variant="default"
          className="h-7"
          disabled={disabled}
          onClick={onExport}
        >
          <Download size={13} />
          {t("editor.export")}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/ry2019/private/FujiSim && git add src/components/Editor/EditorToolbar.tsx && git commit -m "feat(editor): add EditorToolbar"
```

---

## Task 5: `PresetList` 左侧栏

**Files:**
- Create: `src/components/Editor/PresetList.tsx`

- [ ] **Step 1: 创建组件**

```tsx
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Search } from "lucide-react";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { FilterPreset } from "@/types";

export function PresetList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const presets = useStore((s) => s.presets);
  const filter = useStore((s) => s.filter);
  const applyPreset = useStore((s) => s.applyPreset);
  const currentFolderName = useStore((s) => s.currentFolderName);

  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"builtin" | "mine">("builtin");

  const filtered = useMemo(() => {
    const isBuiltin = tab === "builtin";
    return presets.filter(
      (p) =>
        !!p.is_builtin === isBuiltin &&
        p.name.toLowerCase().includes(search.toLowerCase()),
    );
  }, [presets, tab, search]);

  return (
    <aside className="w-[220px] flex-shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800/60 overflow-hidden">
      <div className="h-10 flex-shrink-0 flex items-center gap-2 px-2 border-b border-zinc-800/60">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 flex-shrink-0"
          onClick={() => navigate("/projects")}
        >
          <ArrowLeft size={14} />
        </Button>
        <span className="text-sm text-zinc-200 truncate">{currentFolderName ?? ""}</span>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "builtin" | "mine")} className="flex-1 flex flex-col overflow-hidden">
        <div className="px-2 pt-2">
          <TabsList className="w-full grid grid-cols-2">
            <TabsTrigger value="builtin">{t("editor.presetList.builtin")}</TabsTrigger>
            <TabsTrigger value="mine">{t("editor.presetList.mine")}</TabsTrigger>
          </TabsList>
        </div>

        <div className="relative px-2 mt-2">
          <Search size={12} className="absolute left-4 top-2 text-zinc-500" />
          <Input
            placeholder={t("editor.presetList.searchPlaceholder")}
            className="h-7 pl-7 text-xs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <TabsContent value="builtin" className="flex-1 overflow-y-auto px-2 mt-2 space-y-1">
          {filtered.map((p) => (
            <PresetCard key={p.id} preset={p} active={filter.base_simulation === p.base_simulation} onApply={() => applyPreset(p)} />
          ))}
        </TabsContent>
        <TabsContent value="mine" className="flex-1 overflow-y-auto px-2 mt-2 space-y-1">
          {filtered.length === 0 && (
            <p className="text-[11px] text-zinc-600 px-2 pt-2">{t("filterPanel.noPresets")}</p>
          )}
          {filtered.map((p) => (
            <PresetCard key={p.id} preset={p} active={false} onApply={() => applyPreset(p)} />
          ))}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function PresetCard({ preset, active, onApply }: { preset: FilterPreset; active: boolean; onApply: () => void }) {
  return (
    <button
      type="button"
      onClick={onApply}
      className={cn(
        "w-full text-left rounded-md border px-2 py-2 text-xs transition-colors",
        active
          ? "border-blue-500 bg-blue-500/10 text-zinc-100"
          : "border-zinc-800 hover:border-zinc-600 text-zinc-300",
      )}
    >
      <p className="font-medium truncate">{preset.name}</p>
      <p className="text-[10px] text-zinc-500 truncate mt-0.5">{preset.base_simulation}</p>
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/ry2019/private/FujiSim && git add src/components/Editor/PresetList.tsx && git commit -m "feat(editor): add PresetList sidebar"
```


---

## Task 6: `AssetStrip` 底部缩略图带

**Files:**
- Create: `src/components/Editor/AssetStrip.tsx`

- [ ] **Step 1: 创建组件**

```tsx
import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon } from "lucide-react";
import { useStore } from "@/store";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { Asset } from "@/types";

export function AssetStrip() {
  const { t } = useTranslation();
  const assets = useStore((s) => s.assets);
  const selectedIds = useStore((s) => s.selectedIds);
  const focusedId = useStore((s) => s.focusedId);
  const totalCount = useStore((s) => s.totalCount);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const selectRange = useStore((s) => s.selectRange);
  const focusAsset = useStore((s) => s.focusAsset);

  const scrollerRef = useRef<HTMLDivElement>(null);

  const focused = assets.find((a) => a?.id === focusedId) ?? null;

  function handleClick(asset: Asset, e: React.MouseEvent) {
    if (e.shiftKey) selectRange(asset.id);
    else toggleSelect(asset.id, e.metaKey || e.ctrlKey);
    focusAsset(asset.id);
  }

  // 鼠标垂直滚轮 → 横向滚动
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="h-[140px] flex-shrink-0 flex flex-col border-t border-zinc-800/60 bg-zinc-950/50 overflow-hidden">
      <div className="h-8 flex-shrink-0 flex items-center gap-3 px-3 text-xs text-zinc-400">
        <Select
          value={String(query.min_rating ?? 0)}
          onValueChange={(v) => setQuery({ min_rating: Number(v) || null })}
        >
          <SelectTrigger className="h-6 w-28 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">{t("sidebar.allRatings")}</SelectItem>
            <SelectItem value="1">{t("sidebar.ratingGte1")}</SelectItem>
            <SelectItem value="2">{t("sidebar.ratingGte2")}</SelectItem>
            <SelectItem value="3">{t("sidebar.ratingGte3")}</SelectItem>
            <SelectItem value="4">{t("sidebar.ratingGte4")}</SelectItem>
            <SelectItem value="5">{t("sidebar.rating5")}</SelectItem>
          </SelectContent>
        </Select>
        <span className="truncate flex-1">{focused?.file_name ?? ""}</span>
        <span className="flex-shrink-0">
          {t("editor.strip.selectedCountOfTotal", { n: selectedIds.size, m: totalCount })}
        </span>
        <Button size="sm" variant="ghost" className="h-6 text-[11px]">
          {t("editor.strip.single")}
        </Button>
        <Button size="sm" variant="ghost" className="h-6 text-[11px]" disabled>
          {t("editor.strip.compare")}
        </Button>
      </div>

      <div ref={scrollerRef} className="flex-1 overflow-x-auto overflow-y-hidden">
        {totalCount === 0 ? (
          <div className="h-full flex items-center justify-center text-zinc-500 text-xs">
            {t("editor.emptyFolder")}
          </div>
        ) : (
          <div className="h-full flex items-center gap-2 px-3">
            {assets.map((a, i) =>
              a ? (
                <Thumb
                  key={a.id}
                  asset={a}
                  selected={selectedIds.has(a.id)}
                  focused={focusedId === a.id}
                  onClick={(e) => handleClick(a, e)}
                />
              ) : (
                <div
                  key={`ph-${i}`}
                  className="w-20 h-20 flex-shrink-0 rounded-md bg-zinc-900/60 animate-pulse"
                />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Thumb({
  asset,
  selected,
  focused,
  onClick,
}: {
  asset: Asset;
  selected: boolean;
  focused: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const src = asset.cover_path ? convertFileSrc(asset.cover_path) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-20 h-20 flex-shrink-0 rounded-md overflow-hidden border-2 bg-zinc-900 transition-colors",
        focused
          ? "border-blue-500"
          : selected
            ? "border-blue-500/60"
            : "border-transparent hover:border-zinc-600",
      )}
      title={asset.file_name}
    >
      {src ? (
        <img src={src} className="w-full h-full object-cover" alt="" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-zinc-700">
          <ImageIcon size={20} />
        </div>
      )}
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Editor/AssetStrip.tsx && git commit -m "feat(editor): add AssetStrip"
```

---

## Task 7: 重构 `FilterPanel` 为分节折叠

**Files:**
- Modify: `src/components/FilterPanel.tsx`

注意：此 task 把 Tabs 替换成 Section，**保留所有现有 IPC/store 调用、SaveAsPreset 弹框、LUT 导入逻辑**。预设 Tab 整个删除（已被 PresetList 取代）。

- [ ] **Step 1: 阅读现有 `FilterPanel.tsx` 全文，识别 4 个 TabsContent**

```bash
grep -n 'TabsContent value=' /Users/ry2019/private/FujiSim/src/components/FilterPanel.tsx
```

预期看到 `value="adjust"`、`value="presets"`、`value="watermark"`、`value="info"` 四处。

- [ ] **Step 2: 删除 `presets` Tab 整段内容**

把 `<TabsContent value="presets" ...>...</TabsContent>` 整个块删除（含内部的 PresetRow 列表）。同时删除文件底部 `function PresetRow(...)` 定义。

- [ ] **Step 3: 删除整个 Tabs 框架，改为分节**

把 `return (<aside>...<Tabs>...)</aside>)` 整体替换为以下结构。注意：原 `adjust` tab 的内容拆成 5 个分节（基础/光线/色彩/效果/细节），加上独立的曲线/水印/信息三个折叠分节。

```tsx
import { Section } from "@/components/ui/section";
// ...保留所有现有 import

return (
  <aside className="w-full h-full bg-transparent flex flex-col text-sm overflow-hidden">
    <div className="flex-1 overflow-y-auto">
      <Section title={t("editor.sections.basic")}>
        {/* 基础：胶片模拟选择 + LUT 导入 */}
        <div className="flex items-center justify-between mb-1">
          <Label>{t("filterPanel.filmSimulation")}</Label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={importingLut}
                className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
              >
                {importingLut ? t("filterPanel.importing") : t("filterPanel.importLut")}
                <ChevronDown size={10} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={importLuts}>
                <Files size={13} />
                {t("filterPanel.importFiles")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={importLutsFromDir}>
                <FolderOpen size={13} />
                {t("filterPanel.importDir")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Select value={selectedValue} onValueChange={handleSimulationChange}>
          <SelectTrigger><SelectValue placeholder={t("filterPanel.filmSimulation")} /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{t("filterPanel.systemPresets")}</SelectLabel>
              {fujiSimulations.map((s) => (
                <SelectItem key={s} value={`${FUJI_PREFIX}${s}`}>{s}</SelectItem>
              ))}
            </SelectGroup>
            {userLuts.length > 0 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>{t("filterPanel.userPresets")}</SelectLabel>
                  {userLuts.map((l) => (
                    <SelectItem key={l.id} value={`${LUT_PREFIX}${l.id}`}>{l.name}</SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}
          </SelectContent>
        </Select>
        {filter.base_simulation === PASS_THROUGH_SIM && filter.lut_file_path && (
          <p className="mt-1 text-[10px] text-zinc-500">{t("filterPanel.lutAppliedNotice")}</p>
        )}
      </Section>

      <Section title={t("editor.sections.light")}>
        <SliderRow label={t("filterPanel.highlight")} value={filter.highlight_tone} min={-1} max={1} step={0.05} onChange={(v) => setFilter({ highlight_tone: v })} />
        <SliderRow label={t("filterPanel.shadow")}    value={filter.shadow_tone}    min={-1} max={1} step={0.05} onChange={(v) => setFilter({ shadow_tone: v })} />
      </Section>

      <Section title={t("editor.sections.color")}>
        <SliderRow label={t("filterPanel.saturation")} value={filter.color_saturation} min={-1} max={1} step={0.05} onChange={(v) => setFilter({ color_saturation: v })} />
        <div>
          <Label>{t("filterPanel.colorEffect")}</Label>
          <Select value={filter.color_chrome_effect ?? "None"} onValueChange={(v) => setFilter({ color_chrome_effect: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {CHROME_EFFECTS.map((g) => <SelectItem key={g} value={g}>{grainEffectLabel(g)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <SliderRow label={t("filterPanel.wbShiftR")} value={filter.wb_shift_r} min={-9} max={9} step={1} display={(v) => v.toFixed(0)} onChange={(v) => setFilter({ wb_shift_r: v })} />
        <SliderRow label={t("filterPanel.wbShiftB")} value={filter.wb_shift_b} min={-9} max={9} step={1} display={(v) => v.toFixed(0)} onChange={(v) => setFilter({ wb_shift_b: v })} />
      </Section>

      <Section title={t("editor.sections.effects")}>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>{t("filterPanel.grainStrength")}</Label>
            <Select value={filter.grain_effect ?? "None"} onValueChange={(v) => setFilter({ grain_effect: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {GRAIN_EFFECTS.map((g) => <SelectItem key={g} value={g}>{grainEffectLabel(g)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("filterPanel.grainSize")}</Label>
            <Select value={filter.grain_size ?? "Small"} onValueChange={(v) => setFilter({ grain_size: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {GRAIN_SIZES.map((g) => <SelectItem key={g} value={g}>{grainSizeLabel(g)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <SliderRow label={t("filterPanel.clarity")} value={filter.clarity} min={-1} max={1} step={0.05} onChange={(v) => setFilter({ clarity: v })} />
      </Section>

      <Section title={t("editor.sections.detail")}>
        <SliderRow label={t("filterPanel.sharpness")} value={filter.sharpness} min={-1} max={1} step={0.05} onChange={(v) => setFilter({ sharpness: v })} />
      </Section>

      <Section title={t("editor.sections.curves")} defaultOpen={false}>
        <CurvesEditor
          value={filter.tone_curve}
          onChange={(tc: ToneCurvePoints) => setFilter({ tone_curve: tc })}
        />
      </Section>

      <Section title={t("editor.sections.watermark")} defaultOpen={false}>
        <WatermarkTab />
      </Section>

      <Section title={t("editor.sections.info")} defaultOpen={false}>
        {/* 把原 info TabsContent 内的元数据展示部分粘贴到此处。
            如果原 info Tab 有依赖 focused asset 的逻辑，原样保留。 */}
        {focused ? (
          <div className="text-xs text-zinc-400 space-y-1">
            <div className="flex justify-between"><span>{t("filterPanel.fileName")}</span><span className="text-zinc-200 truncate ml-2">{focused.file_name}</span></div>
            <div className="flex justify-between"><span>{t("filterPanel.fileSize")}</span><span className="text-zinc-200">{formatBytes(focused.file_size ?? 0)}</span></div>
            <div className="flex justify-between"><span>{t("filterPanel.dateTaken")}</span><span className="text-zinc-200">{shortDate(focused.date_taken)}</span></div>
            <div className="flex justify-between"><span>{t("filterPanel.camera")}</span><span className="text-zinc-200 truncate ml-2">{focused.camera_model ?? "-"}</span></div>
            <div className="flex justify-between"><span>{t("filterPanel.lens")}</span><span className="text-zinc-200 truncate ml-2">{focused.lens_model ?? "-"}</span></div>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">{t("editor.noFocused")}</p>
        )}
      </Section>

      <div className="flex gap-2 px-4 py-3 border-t border-zinc-800/60">
        <Button size="sm" variant="outline" onClick={resetFilter} className="flex-1 border-zinc-800 hover:bg-zinc-800">{t("common.reset")}</Button>
        <Button size="sm" variant="default" onClick={() => setSaveOpen(true)} className="flex-1">
          <Save size={12} /> {t("filterPanel.saveAsPreset")}
        </Button>
      </div>
    </div>

    {/* 保留：SaveAsPreset Dialog（原 Tabs 外存在，原样保留） */}
  </aside>
);
```

- [ ] **Step 4: 移除 Tabs 相关 import**

删除以下 import 行（如还有）：

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
```

如果 `WatermarkTab` 之前是 inline 渲染，本次直接调用 `<WatermarkTab />` 组件即可（已存在的导出）。

- [ ] **Step 5: TypeScript 检查**

```bash
pnpm build 2>&1 | grep "error TS"
```

修复任何 TS error，常见有：未使用的 import（移除）、`focused` 变量名是否已存在（如不存在，从 store 获取：`const focused = assets.find((a) => a?.id === focusedId) ?? null;`）。

- [ ] **Step 6: Commit**

```bash
cd /Users/ry2019/private/FujiSim && git add src/components/FilterPanel.tsx && git commit -m "refactor(filter): replace Tabs with collapsible Sections"
```


---

## Task 8: 重构 `EditorPage` 拼装新布局

**Files:**
- Modify: `src/pages/EditorPage.tsx`

- [ ] **Step 1: 完全替换 `EditorPage.tsx` 为以下内容**

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { PreviewPanel } from "@/components/PreviewPanel";
import { FilterPanel } from "@/components/FilterPanel";
import { ExportDialog } from "@/components/ExportDialog";
import { PresetList } from "@/components/Editor/PresetList";
import { EditorToolbar } from "@/components/Editor/EditorToolbar";
import { AssetStrip } from "@/components/Editor/AssetStrip";
import { useStore } from "@/store";

export function EditorPage() {
  const { folderId } = useParams<{ folderId: string }>();
  const enterFolder = useStore((s) => s.enterFolder);
  const exitFolder = useStore((s) => s.exitFolder);
  const albums = useStore((s) => s.albums);
  const [exportOpen, setExportOpen] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);

  useEffect(() => {
    if (!folderId) return;
    const id = Number(folderId);
    const album = albums.find((a) => a.id === id);
    const name = album?.name ?? String(id);
    enterFolder(id, name);
    return () => {
      exitFolder();
    };
  }, [folderId]);

  return (
    <div className="flex-1 flex min-h-0 bg-zinc-950 overflow-hidden">
      <PresetList />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <EditorToolbar
          showOriginal={showOriginal}
          onToggleShowOriginal={() => setShowOriginal((v) => !v)}
          onExport={() => setExportOpen(true)}
        />
        <div className="flex-1 min-h-0 overflow-hidden">
          <PreviewPanel
            showOriginal={showOriginal}
            onShowOriginalChange={setShowOriginal}
          />
        </div>
        <AssetStrip />
      </div>

      <div className="w-[340px] flex-shrink-0 flex flex-col bg-zinc-950/50 border-l border-zinc-800/60 overflow-hidden">
        <FilterPanel />
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
    </div>
  );
}
```

- [ ] **Step 2: 检查 PreviewPanel 组件是否还需要 `onExport` prop**

由于导出按钮已移到 EditorToolbar，PreviewPanel 内的导出按钮（如有）应改为不渲染，或保留但不展示。最少改动：保留 `onExport?: () => void` 为 optional，PreviewPanel 内若有调用 `onExport`，仅在它存在时渲染。EditorPage 不再传 `onExport`。

如果 PreviewPanel 内有这种代码：
```tsx
<button onClick={onExport}>...</button>
```
保持不变，仅在外部不传 prop。该按钮要么消失（如有 `if (onExport)` 守卫），要么保持但永不触发。后续可清理。

- [ ] **Step 3: TypeScript 检查**

```bash
pnpm build 2>&1 | grep "error TS"
```

预期错误处理：
- 若 PreviewPanel 的 `onExport` 在 Task 3 已设为 optional，则无错误
- 若仍是 required，临时把它改成 optional：在 PreviewPanel 的 props interface 改 `onExport?: () => void`

- [ ] **Step 4: Commit**

```bash
git add src/pages/EditorPage.tsx src/components/PreviewPanel.tsx && git commit -m "feat(editor): assemble 4-region editor layout"
```

---

## Task 9: 删除废弃组件

**Files:**
- Delete: `src/components/AssetList/`
- Delete: `src/components/Sidebar.tsx`（确认无引用后）

- [ ] **Step 1: 检查 AssetList/Sidebar 是否还有引用**

```bash
cd /Users/ry2019/private/FujiSim && grep -rn "AssetList\|/Sidebar" src/ --include="*.tsx" --include="*.ts"
```

预期：除了 `src/components/AssetList/` 内部相互引用、`src/components/Sidebar.tsx` 自身外，无外部引用。如果有，定位并清理。

- [ ] **Step 2: 删除目录与文件**

```bash
cd /Users/ry2019/private/FujiSim && rm -rf src/components/AssetList && rm -f src/components/Sidebar.tsx
```

- [ ] **Step 3: TypeScript 检查**

```bash
pnpm build 2>&1 | grep "error TS"
```

Expected: 无 error。

- [ ] **Step 4: Commit**

```bash
cd /Users/ry2019/private/FujiSim && git add -A && git commit -m "chore: remove unused AssetList and Sidebar components"
```

---

## Task 10: 最终整合验证

**Files:** 无新文件

- [ ] **Step 1: 全量 TS 构建**

```bash
cd /Users/ry2019/private/FujiSim && pnpm build 2>&1 | tail -5
```

Expected: `✓ built in ...`

- [ ] **Step 2: 启动并验收（手动）**

```bash
pnpm tauri dev
```

打开应用，进入 `项目` → 任意文件夹，验收：
- 左侧 220px 预设列表能切 推荐/我的，搜索可用
- 中间预览区上方有 重置/显示原图/导出 三个按钮
- 中间下方有横向缩略图带，可点击切换
- 右侧 340px 滤镜面板是分节折叠风格，能展开收起
- 重置按钮调 `resetFilter`、显示原图按钮切换 `showOriginal`、导出按钮打开 ExportDialog

如有视觉/功能问题，记录后单独修复。

- [ ] **Step 3: Final commit**

如有手动调整代码：
```bash
cd /Users/ry2019/private/FujiSim && git add -A && git commit -m "feat: editor page redesign — final integration"
```

否则跳过。


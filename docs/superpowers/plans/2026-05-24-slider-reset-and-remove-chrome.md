# Slider Reset + Remove Chrome Effect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add double-click-to-reset to slider thumbs and fully remove the `color_chrome_effect` field from FE+BE.

**Architecture:** Two cohesive changes packaged together: (1) Extend `Slider` primitive with optional `onThumbDoubleClick` prop, plumb through `SliderRow` with `resetValue` default 0; (2) Delete `color_chrome_effect` field from all 12 sites (TS types, defaults, store, components, i18n, Rust struct, DB schema+upsert, seed) since the UI dropdown was the only producer and 13 builtin presets all default to None — no algorithm change has user-visible effect.

**Tech Stack:** React + TypeScript + Radix Slider; Rust + sqlx (SQLite). No vitest in this project — verification via `cargo test` (24 existing) + `pnpm tsc --noEmit && pnpm build`.

**Spec:** [docs/superpowers/specs/2026-05-24-slider-reset-and-remove-chrome-design.md](../specs/2026-05-24-slider-reset-and-remove-chrome-design.md)

---

## 全局约定

- 文件硬上限 500 行（项目 CLAUDE.md）。
- 后端必跑：`cd src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test`
- 前端必跑：`pnpm tsc --noEmit && pnpm build`
- 提交前 `git add <specific-files>`，禁止 `git add -A`。
- 提交签名：`git -c commit.gpgsign=false commit -m "..."`
- 工作目录：`/Users/ry2019/private/FujiSim`，分支 `feature/raw-3`。
- 提交风格：Conventional Commits。

---

## 文件结构

### 修改（前端 9 个）
- `src/components/ui/slider.tsx` — 新增 `onThumbDoubleClick` prop
- `src/components/ui/form.tsx` — 新增 `resetValue` prop，转发给 `Slider`
- `src/components/FilterPanel.tsx` — 删除色彩效果 Select、`CHROME_EFFECTS`、payload chrome 行
- `src/types.ts` — 删 `FilterSettings` 与 `FilterPreset` 的 `color_chrome_effect` 字段
- `src/store/defaults.ts` — 删 `DEFAULT_FILTER.color_chrome_effect`
- `src/store/slices/filter.ts` — 删 `presetToFilter` 中的 chrome 映射
- `src/components/PreviewPanel.tsx` — 删 `isIdentity` 中的 chrome 检查行
- `src/i18n/zh.ts` — 删 `colorEffect`
- `src/i18n/en.ts` — 删 `colorEffect`

### 修改（后端 4 个）
- `src-tauri/src/processing/pipeline.rs` — 删字段、Default、is_identity、chrome 计算与 HSL 块
- `src-tauri/src/db/presets.rs` — 删两个 struct 字段、upsert SQL 列/?/bind/ON CONFLICT
- `src-tauri/src/db/mod.rs` — 删 SCHEMA 列、增 ALTER TABLE DROP COLUMN 迁移
- `src-tauri/src/state.rs` — 删 seed_builtin_presets 字面量字段

## Phase 1：滑块双击重置

### Task 1: `Slider` 接受 `onThumbDoubleClick`

**Files:**
- Modify: `src/components/ui/slider.tsx`

- [ ] **Step 1.1: 整体替换文件内容**

```tsx
import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
  onThumbDoubleClick?: () => void;
};

export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>(({ className, onThumbDoubleClick, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn("relative flex w-full touch-none items-center select-none", className)}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-zinc-700">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      onDoubleClick={onThumbDoubleClick}
      className="block h-3.5 w-3.5 rounded-full border border-primary bg-primary-foreground shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
    />
  </SliderPrimitive.Root>
));
Slider.displayName = "Slider";
```

- [ ] **Step 1.2: 类型检查**

```bash
cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit
```

预期：通过。`SliderProps` 通过 intersection 加上 optional 字段，对所有现有调用方向后兼容。

- [ ] **Step 1.3: 提交**

```bash
git add src/components/ui/slider.tsx
git -c commit.gpgsign=false commit -m "feat(ui): add onThumbDoubleClick prop to Slider"
```
---

### Task 2: `SliderRow` 接入 `resetValue`

**Files:**
- Modify: `src/components/ui/form.tsx`

- [ ] **Step 2.1: 替换 `SliderRow` 函数**

打开 `src/components/ui/form.tsx`，找到 `export function SliderRow` 块，整体替换：

```tsx
export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
  resetValue = 0,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  display?: (v: number) => string;
  resetValue?: number;
}) {
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="text-xs text-zinc-300">{label}</span>
        <span className="text-[10px] text-zinc-500 tabular-nums">
          {display ? display(value) : value.toFixed(2)}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
        onThumbDoubleClick={() => onChange(resetValue)}
      />
    </div>
  );
}
```

`Label` 与 `ToggleSwitch` 不动。

- [ ] **Step 2.2: 类型检查 + 构建**

```bash
cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit && pnpm build
```

预期：通过。所有 11 个 SliderRow 调用方都不需要传 resetValue（默认 0 适用）。

- [ ] **Step 2.3: 提交**

```bash
git add src/components/ui/form.tsx
git -c commit.gpgsign=false commit -m "feat(form): SliderRow forwards double-click reset to thumb"
```
---

## Phase 2：移除 color_chrome_effect（前端）

### Task 3: 前端类型与 store 清理

**Files:**
- Modify: `src/types.ts`
- Modify: `src/store/defaults.ts`
- Modify: `src/store/slices/filter.ts`

- [ ] **Step 3.1: 删除 types.ts 两处字段**

`src/types.ts` 在两个 type 中分别删除 `color_chrome_effect?: string | null;` 一行：
- `FilterSettings`（约 line 73）
- `FilterPreset`（约 line 113）

确认仅删 2 行；其它字段保留。

- [ ] **Step 3.2: 删除 DEFAULT_FILTER 字段**

`src/store/defaults.ts`，找到 `color_chrome_effect: "None"`（约 line 11）整行删除。

- [ ] **Step 3.3: 删除 presetToFilter 字段**

`src/store/slices/filter.ts`，找到 `color_chrome_effect: preset.color_chrome_effect ?? "None",`（约 line 12）整行删除。

- [ ] **Step 3.4: 类型检查（会临时报错）**

```bash
cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit
```

预期：剩余错误集中在 `FilterPanel.tsx`、`PreviewPanel.tsx`（仍引用已删字段）。Task 4 / 5 会修。

- [ ] **Step 3.5: 提交**

```bash
git add src/types.ts src/store/defaults.ts src/store/slices/filter.ts
git -c commit.gpgsign=false commit -m "refactor(types): remove color_chrome_effect from FilterSettings and store"
```
---

### Task 4: FilterPanel 删除色彩效果 Select 与 payload

**Files:**
- Modify: `src/components/FilterPanel.tsx`

- [ ] **Step 4.1: 删除 CHROME_EFFECTS 常量**

`src/components/FilterPanel.tsx` 顶部找到 `const CHROME_EFFECTS = ["None", "Weak", "Strong"];`（约 line 34）整行删除。

- [ ] **Step 4.2: 删除「颜色」Section 的 Select 块**

找到 `<Section title={t("editor.sections.color")}>` 内的色彩效果块：

```tsx
          <div>
            <Label>{t("filterPanel.colorEffect")}</Label>
            <Select value={filter.color_chrome_effect ?? "None"} onValueChange={(v) => setFilter({ color_chrome_effect: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CHROME_EFFECTS.map((g) => <SelectItem key={g} value={g}>{grainEffectLabel(g)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
```

整段（含外层 `<div>`）删除。注意保留同 Section 中前后的 SliderRow（vibrance、saturation、wbShiftR、wbShiftB）。

- [ ] **Step 4.3: 删除 saveAsPreset payload 中的 chrome 行**

找到 `saveAsPreset` 函数中 `await api.savePreset({...})` 的 payload。删除 `color_chrome_effect: filter.color_chrome_effect ?? null,` 这一行。

- [ ] **Step 4.4: 检查未使用 import**

如果 `Select`/`SelectTrigger`/`SelectContent`/`SelectItem`/`SelectValue` 现在没有其它使用——`grep -n "Select" src/components/FilterPanel.tsx`——保留它们仍然合法但 tsc 可能不会报 unused（项目未启用 noUnusedLocals strict）。如果 clippy 等价工具报告 unused，删除对应 import。

如果 `Label` 现在没有其它使用，删除 `Label` 的 import 项。

- [ ] **Step 4.5: 类型检查 + 构建**

```bash
cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit && pnpm build
```

预期：仅 PreviewPanel 仍报错（Task 5 修）。

- [ ] **Step 4.6: 提交**

```bash
git add src/components/FilterPanel.tsx
git -c commit.gpgsign=false commit -m "refactor(filter-panel): remove color effect Select and payload field"
```
---

### Task 5: PreviewPanel + i18n 清理

**Files:**
- Modify: `src/components/PreviewPanel.tsx`
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 5.1: 删除 PreviewPanel isIdentity chrome 行**

`src/components/PreviewPanel.tsx` 约 line 173，找到：

```tsx
        (!filter.color_chrome_effect || filter.color_chrome_effect === "None") &&
```

整行删除。前后行（grain check 与 tone_curve check）保持不变。

- [ ] **Step 5.2: 删除 zh.ts colorEffect 行**

`src/i18n/zh.ts` 约 line 66，找到 `colorEffect: "色彩效果",`，整行删除。

> 注意：保留 `strengthLabels` 与 `sizeLabels` 子对象，颗粒效果仍依赖。

- [ ] **Step 5.3: 删除 en.ts colorEffect 行**

`src/i18n/en.ts` 约 line 66，找到 `colorEffect: "Color effect",`，整行删除。

- [ ] **Step 5.4: 类型检查 + 构建**

```bash
cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit && pnpm build
```

预期：全部通过。前端再无引用 `color_chrome_effect`。验证：

```bash
grep -rn "color_chrome_effect\|colorEffect" /Users/ry2019/private/FujiSim/src
```

预期：零结果。

- [ ] **Step 5.5: 提交**

```bash
git add src/components/PreviewPanel.tsx src/i18n/zh.ts src/i18n/en.ts
git -c commit.gpgsign=false commit -m "refactor(preview/i18n): drop chrome effect identity check and label"
```
---

## Phase 3：移除 color_chrome_effect（后端）

### Task 6: pipeline.rs 删字段与算法块

**Files:**
- Modify: `src-tauri/src/processing/pipeline.rs`

- [ ] **Step 6.1: 删除 FilterSettings 字段**

约 line 45-46，找到：

```rust
    #[serde(default)]
    pub color_chrome_effect: Option<String>,
```

整两行删除。

- [ ] **Step 6.2: 删除 is_identity 中的 chrome 检查**

约 line 100，找到：

```rust
            && matches!(self.color_chrome_effect.as_deref(), None | Some("None"))
```

整行删除（含前面的 `&&` 续接）。

- [ ] **Step 6.3: 删除 Default 字段**

约 line 113，找到：

```rust
            color_chrome_effect: None,
```

整行删除。

- [ ] **Step 6.4: 删除 chrome_strength 计算**

约 line 198-203，找到：

```rust
    // Color Chrome 在 HSL 空间根据现有饱和度做"再升一档"
    let chrome_strength = match settings.color_chrome_effect.as_deref().unwrap_or("None") {
        "Weak" => 0.15,
        "Strong" => 0.30,
        _ => 0.0,
    };
```

整段删除（包括注释）。

- [ ] **Step 6.5: 删除 [8] Color Chrome HSL 块**

约 line 305-312，找到：

```rust
        // [8] Color Chrome：在 HSL 空间提升已经较饱和的区域
        if chrome_strength > 0.0 {
            let (h_, s, lv) = color::rgb_to_hsl(r, g, b);
            let boosted_s = (s + chrome_strength * (1.0 - s) * 0.5).clamp(0.0, 1.0);
            let (cr, cg, cb) = color::hsl_to_rgb(h_, boosted_s, lv);
            r = cr;
            g = cg;
            b = cb;
        }
```

整段（含注释行）删除。其后续步骤（褪色 / 黑白 / LUT）位置不变。

- [ ] **Step 6.6: 编译 + clippy + test**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo build && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

预期：cargo build 通过；cargo test 24 个全过；clippy 无新增 warning。

注意：`color::rgb_to_hsl` / `color::hsl_to_rgb` 仍被 `saturation.rs` 内部使用，不能删 import。验证：

```bash
grep -n "rgb_to_hsl\|hsl_to_rgb" /Users/ry2019/private/FujiSim/src-tauri/src/processing/pipeline.rs
```

预期：零结果（pipeline 不再直接调用这两个）。但 saturation.rs 仍 import 它们 — 这没问题，是另一文件。

- [ ] **Step 6.7: 提交**

```bash
git add src-tauri/src/processing/pipeline.rs
git -c commit.gpgsign=false commit -m "refactor(pipeline): remove color_chrome_effect field and HSL chrome block"
```
---

### Task 7: db::presets 删字段与 SQL

**Files:**
- Modify: `src-tauri/src/db/presets.rs`

- [ ] **Step 7.1: FilterPreset 删字段**

约 line 16，找到 `pub color_chrome_effect: Option<String>,` 整行删除。

- [ ] **Step 7.2: NewFilterPreset 删字段**

约 line 44，找到 `pub color_chrome_effect: Option<String>,` 整行删除。

- [ ] **Step 7.3: upsert SQL 删列**

找到 `pub async fn upsert(...)` 内的 `r#"INSERT INTO filter_presets ..."#` 字符串。

INSERT 列列表：删 `color_chrome_effect,`，使列数从 22 → 21。
VALUES：删 1 个 `?`，使从 22 → 21。
ON CONFLICT 子句：删 `             color_chrome_effect=excluded.color_chrome_effect,` 整行（含末尾逗号 — 注意确认它不是最后一行，删除后剩下的最后一行不能尾随逗号）。

新版 SQL（参考实现，整体替换 `r#"..."#` 字符串内容）：

```rust
        r#"INSERT INTO filter_presets (name,base_simulation,grain_effect,grain_size,exposure,contrast,brightness,highlight_tone,shadow_tone,white,black,dehaze,vibrance,color_saturation,clarity,sharpness,wb_shift_r,wb_shift_b,lut_file_path,is_builtin,category_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(name) DO UPDATE SET
             base_simulation=excluded.base_simulation,
             grain_effect=excluded.grain_effect,
             grain_size=excluded.grain_size,
             exposure=excluded.exposure,
             contrast=excluded.contrast,
             brightness=excluded.brightness,
             highlight_tone=excluded.highlight_tone,
             shadow_tone=excluded.shadow_tone,
             white=excluded.white,
             black=excluded.black,
             dehaze=excluded.dehaze,
             vibrance=excluded.vibrance,
             color_saturation=excluded.color_saturation,
             clarity=excluded.clarity,
             sharpness=excluded.sharpness,
             wb_shift_r=excluded.wb_shift_r,
             wb_shift_b=excluded.wb_shift_b,
             lut_file_path=excluded.lut_file_path,
             is_builtin=excluded.is_builtin,
             category_id=excluded.category_id"#,
```

确认：21 列、21 个 `?`、20 行 ON CONFLICT SET（去掉 base_simulation 不更新自己也是 21 列 - 1）。逐字数过。

- [ ] **Step 7.4: upsert .bind 链删一项**

找到对应的 `.bind(&p.color_chrome_effect)` 行（约 line 97），整行删除。

新 bind 链顺序应为（21 个）：name, base_simulation, grain_effect, grain_size, exposure, contrast, brightness, highlight_tone, shadow_tone, white, black, dehaze, vibrance, color_saturation, clarity, sharpness, wb_shift_r, wb_shift_b, lut_file_path, is_builtin as i64, category_id。

- [ ] **Step 7.5: 编译 + clippy + test**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo build && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

预期：通过。Test 24 不变。

- [ ] **Step 7.6: 提交**

```bash
git add src-tauri/src/db/presets.rs
git -c commit.gpgsign=false commit -m "refactor(db): drop color_chrome_effect from presets struct and upsert"
```
---

### Task 8: db/mod.rs schema + 迁移

**Files:**
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 8.1: 删 SCHEMA 中的列**

约 line 244，找到：

```sql
    color_chrome_effect TEXT,
```

整行删除。前后行（grain_size 与 exposure）保持不变。

- [ ] **Step 8.2: 增量迁移加 DROP COLUMN**

打开 `run_migrations` 内的第一段 `for sql in [ ... ]` 数组（已含 DROP TABLE filter_presets 那一条）。在数组**末尾**追加：

```rust
        "ALTER TABLE filter_presets DROP COLUMN color_chrome_effect",
```

执行顺序：DROP TABLE 在前 → SCHEMA 重建（无 chrome 列）→ 此 ALTER 失败被忽略（列已不存在）。这一条 ALTER 只对从更早版本升级（已有 chrome 列、未触发 DROP TABLE 路径）的数据库生效。SQLite < 3.35 失败也被忽略，列遗留无影响。

- [ ] **Step 8.3: 编译 + test**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo build && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

- [ ] **Step 8.4: 提交**

```bash
git add src-tauri/src/db/mod.rs
git -c commit.gpgsign=false commit -m "refactor(db): drop color_chrome_effect column from schema and add migration"
```
---

### Task 9: state.rs seed 字面量

**Files:**
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 9.1: 删 seed_builtin_presets 字面量字段**

约 line 113，找到 `seed_builtin_presets` 内的 `NewFilterPreset { ... }` 字面量中：

```rust
            color_chrome_effect: None,
```

整行删除。

- [ ] **Step 9.2: 编译 + test**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo build && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

预期：cargo build 通过（NewFilterPreset 字段已在 Task 7 删去，不补就编译失败说明步骤错了）。

- [ ] **Step 9.3: 后端整体冒烟**

最后跑一遍验证后端三件套：

```bash
grep -rn "color_chrome_effect" /Users/ry2019/private/FujiSim/src-tauri/src
```

预期：零结果。

- [ ] **Step 9.4: 提交**

```bash
git add src-tauri/src/state.rs
git -c commit.gpgsign=false commit -m "refactor(state): drop color_chrome_effect from seed_builtin_presets"
```
---

## Phase 4：验收

### Task 10: 全量验证 + 手动 smoke

**Files:** 无文件改动。

- [ ] **Step 10.1: 后端全量验证**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

预期：通过；测试数仍为 24（无新增/删除测试）。

- [ ] **Step 10.2: 前端全量验证**

```bash
cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit && pnpm build
```

预期：通过。

- [ ] **Step 10.3: 字段彻底清理验证**

```bash
grep -rn "color_chrome_effect\|colorEffect\|CHROME_EFFECTS\|chrome_strength" /Users/ry2019/private/FujiSim/src /Users/ry2019/private/FujiSim/src-tauri/src
```

预期：零结果。

- [ ] **Step 10.4: 端到端手动 smoke**

```bash
pnpm tauri dev
```

按 spec §3.3 + §4.4 验证：

1. 「调整」→「颜色」Section：仅鲜艳度、饱和度、色温 R、色温 B（无色彩效果下拉）
2. 双击曝光 / 对比度 / 任意 SliderRow 的 thumb，参数回到 0，预览实时刷新
3. 切换内置富士预设（Velvia、Classic Chrome）：视觉与上一版相比仅有微小差异（chrome 加权丢失，其他不变）
4. 保存自定义预设、应用、删除 — 流程正常，category_id 仍持久化
5. 应用启动无崩溃，13 个内置预设回填正常

Ctrl+C 停止。

- [ ] **Step 10.5: 如有最后修复**

```bash
git status
# 如需修复
git add -A
git -c commit.gpgsign=false commit -m "chore: e2e smoke fixes"
```

---

## 任务汇总

| Task | 说明 |
| --- | --- |
| 1 | Slider primitive 加 onThumbDoubleClick prop |
| 2 | SliderRow 转发 resetValue（默认 0） |
| 3 | 前端 types + DEFAULT_FILTER + presetToFilter 删字段 |
| 4 | FilterPanel 删 Select / CHROME_EFFECTS / payload |
| 5 | PreviewPanel + i18n 删 colorEffect |
| 6 | pipeline.rs 删字段、Default、is_identity、HSL 块 |
| 7 | db::presets 删字段 + 改 upsert SQL（21 列） |
| 8 | db schema 删列 + ALTER TABLE 迁移 |
| 9 | state.rs seed 删字段 |
| 10 | 全量验收 + 手动 smoke |


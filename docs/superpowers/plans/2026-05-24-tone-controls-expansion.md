# Tone Controls Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the empty 「基础」 Section's film simulation dropdown with 11 Lightroom-style tone controls (exposure, contrast, brightness, highlight, shadow, white, black, dehaze, vibrance, saturation, clarity), wired through the Rust pipeline including a Dark Channel Prior dehaze implementation.

**Architecture:** Backend introduces 7 new fields on `FilterSettings` and migrates 4 existing tone fields from `f32 ∈ [-1, 1]` to `i32 ∈ [-100, 100]` (plus `exposure: f32 ∈ [-5, 5]`). The pipeline is reorganized into LR-style order via three new sub-modules (`tone.rs`, `dehaze.rs`, `saturation.rs`). Database table `filter_presets` is dropped and recreated with the new schema (user presets discarded; 13 builtins reseed at startup). Frontend regroups the 「调整」 tab into Basic/Light/Color/Effects/Detail/Curves sections.

**Tech Stack:** Rust + sqlx (SQLite) + Tauri IPC, image/rayon for pixel ops; React + TypeScript + Zustand + shadcn/ui + Tailwind. No vitest in this project — verification via `pnpm tsc --noEmit && pnpm build` plus manual smoke.

**Spec:** [docs/superpowers/specs/2026-05-24-tone-controls-expansion-design.md](../specs/2026-05-24-tone-controls-expansion-design.md)

---

## 全局约定

- TDD：每个含算法的任务先写失败测试再实现。纯 schema/字段串接的任务允许直接改+构建验证。
- 单文件硬限 500 行（项目 CLAUDE.md）。
- 后端必跑：`cd src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test`
- 前端必跑：`pnpm tsc --noEmit && pnpm build`（项目无 lint/test 脚本）。
- 提交风格：Conventional Commits。
- 提交前 `git add <specific-files>`，禁止 `git add -A`。
- 提交签名：`git -c commit.gpgsign=false commit -m "..."`
- 工作目录：`/Users/ry2019/private/FujiSim`，分支 `feature/raw-3`。

---

## 文件结构

### 新建（后端）
- `src-tauri/src/processing/tone.rs` — exposure/contrast/brightness/tone-segments
- `src-tauri/src/processing/dehaze.rs` — DCP + guided filter
- `src-tauri/src/processing/saturation.rs` — vibrance + saturation

### 修改（后端）
- `src-tauri/src/processing/pipeline.rs` — `FilterSettings` 字段、`process_image` 编排
- `src-tauri/src/processing/mod.rs` — 模块声明
- `src-tauri/src/db/mod.rs` — DROP+CREATE filter_presets
- `src-tauri/src/db/presets.rs` — 结构体字段、upsert SQL
- `src-tauri/src/state.rs` — seed 字面量补字段

### 修改（前端）
- `src/types.ts` — `FilterSettings`、`FilterPreset` 字段
- `src/store/defaults.ts` — `DEFAULT_FILTER`
- `src/store/slices/filter.ts` — `presetToFilter`
- `src/components/FilterPanel.tsx` — 重组 Section、删除胶片模拟下拉
- `src/components/PreviewPanel.tsx` — identity 检查同步新字段
- `src/i18n/zh.ts` / `src/i18n/en.ts` — 新 key + 删旧 key

## Phase 1：后端数据层

### Task 1: `FilterSettings` 字段重定义 + serde

**Files:**
- Modify: `src-tauri/src/processing/pipeline.rs` (lines 33-100, just struct + Default + is_identity)

- [ ] **Step 1.1: 替换 `FilterSettings` 结构体定义**

打开 `src-tauri/src/processing/pipeline.rs`，找到 `pub struct FilterSettings` 块（约 33-60 行），整体替换为：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterSettings {
    pub base_simulation: String,
    #[serde(default)]
    pub grain_effect: Option<String>,
    #[serde(default)]
    pub grain_size: Option<String>,
    #[serde(default)]
    pub color_chrome_effect: Option<String>,
    #[serde(default)]
    pub exposure: f32,
    #[serde(default)]
    pub contrast: i32,
    #[serde(default)]
    pub brightness: i32,
    #[serde(default)]
    pub highlight_tone: i32,
    #[serde(default)]
    pub shadow_tone: i32,
    #[serde(default)]
    pub white: i32,
    #[serde(default)]
    pub black: i32,
    #[serde(default)]
    pub dehaze: i32,
    #[serde(default)]
    pub vibrance: i32,
    #[serde(default)]
    pub color_saturation: i32,
    #[serde(default)]
    pub clarity: i32,
    #[serde(default)]
    pub sharpness: i32,
    #[serde(default)]
    pub wb_shift_r: i32,
    #[serde(default)]
    pub wb_shift_b: i32,
    #[serde(default)]
    pub tone_curve: Option<ToneCurvePoints>,
    #[serde(default)]
    pub lut_file_path: Option<PathBuf>,
}
```
- [ ] **Step 1.2: 替换 `is_identity` 实现**

找到 `impl FilterSettings { pub fn is_identity ... }` 块，整体替换：

```rust
impl FilterSettings {
    pub fn is_identity(&self) -> bool {
        (self.base_simulation == "Pass-Through" || self.base_simulation.is_empty())
            && self.lut_file_path.is_none()
            && self.exposure == 0.0
            && self.contrast == 0
            && self.brightness == 0
            && self.highlight_tone == 0
            && self.shadow_tone == 0
            && self.white == 0
            && self.black == 0
            && self.dehaze == 0
            && self.vibrance == 0
            && self.color_saturation == 0
            && self.clarity == 0
            && self.sharpness == 0
            && self.wb_shift_r == 0
            && self.wb_shift_b == 0
            && matches!(self.grain_effect.as_deref(), None | Some("None"))
            && matches!(self.color_chrome_effect.as_deref(), None | Some("None"))
            && self.tone_curve.as_ref().map_or(true, |tc| {
                tc.rgb.is_empty() && tc.r.is_empty() && tc.g.is_empty() && tc.b.is_empty()
            })
    }
}
```

- [ ] **Step 1.3: 替换 `impl Default for FilterSettings`**

```rust
impl Default for FilterSettings {
    fn default() -> Self {
        Self {
            base_simulation: "Pass-Through".into(),
            grain_effect: None,
            grain_size: None,
            color_chrome_effect: None,
            exposure: 0.0,
            contrast: 0,
            brightness: 0,
            highlight_tone: 0,
            shadow_tone: 0,
            white: 0,
            black: 0,
            dehaze: 0,
            vibrance: 0,
            color_saturation: 0,
            clarity: 0,
            sharpness: 0,
            wb_shift_r: 0,
            wb_shift_b: 0,
            tone_curve: None,
            lut_file_path: None,
        }
    }
}
```
- [ ] **Step 1.4: 临时让 pipeline.rs 仍能编译**

`process_image` 函数体仍引用旧的 f32 字段（如 `settings.highlight_tone + profile.contrast * 0.0`、`settings.color_saturation`、`apply_clarity(..., settings.clarity, ...)`）。这些会在 Task 7 重写。**当前任务**：把所有 `settings.{highlight_tone,shadow_tone,color_saturation,clarity,sharpness}` 改为 `(settings.<field> as f32 / 100.0)`。具体改动如下（行号近似）：

- 行 ~134 `settings.highlight_tone + profile.contrast * 0.0` → `(settings.highlight_tone as f32 / 100.0) + profile.contrast * 0.0`
- 行 ~135 `settings.shadow_tone` → `(settings.shadow_tone as f32 / 100.0)`
- 行 ~225 `settings.color_saturation` → `(settings.color_saturation as f32 / 100.0)`
- 行 ~273 `settings.clarity.abs() > 0.001` → `settings.clarity != 0`
- 行 ~275 `settings.clarity` → `(settings.clarity as f32 / 100.0)`
- 行 ~277 `settings.sharpness.abs() > 0.001` → `settings.sharpness != 0`
- 行 ~279 `settings.sharpness` → `(settings.sharpness as f32 / 100.0)`

> 这是临时垫片，让 cargo build 在 Task 1 阶段能过；Task 7 重写 pipeline 时会全部替换为新算法。

- [ ] **Step 1.5: 编译**

```bash
cd src-tauri && cargo build
```

预期：通过（可能有 unused field 警告，clippy 阶段一并处理）。

- [ ] **Step 1.6: clippy + fmt（可能临时允许 dead_code）**

```bash
cd src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings
```

`exposure / contrast / brightness / white / black / dehaze / vibrance` 7 个新字段在 pipeline 内还没用到，会触发 `dead_code`。**对策**：在 `FilterSettings` 上方加 `#[allow(dead_code)]`（仅本任务过渡期保留），Task 7 全部用上后移除。

- [ ] **Step 1.7: 提交**

```bash
git add src-tauri/src/processing/pipeline.rs
git -c commit.gpgsign=false commit -m "feat(pipeline): redefine FilterSettings with 7 new tone fields and integer ranges"
```
---

### Task 2: `db::presets` 字段扩展 + upsert SQL

**Files:**
- Modify: `src-tauri/src/db/presets.rs`
- Modify: `src-tauri/src/state.rs` (the seed_builtin_presets literal)

- [ ] **Step 2.1: 替换 `FilterPreset` 结构体**

打开 `src-tauri/src/db/presets.rs`，把 `pub struct FilterPreset` 替换为：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct FilterPreset {
    pub id: i64,
    pub name: String,
    pub base_simulation: String,
    pub grain_effect: Option<String>,
    pub grain_size: Option<String>,
    pub color_chrome_effect: Option<String>,
    pub exposure: f64,
    pub contrast: i64,
    pub brightness: i64,
    pub highlight_tone: i64,
    pub shadow_tone: i64,
    pub white: i64,
    pub black: i64,
    pub dehaze: i64,
    pub vibrance: i64,
    pub color_saturation: i64,
    pub clarity: i64,
    pub sharpness: i64,
    pub wb_shift_r: i64,
    pub wb_shift_b: i64,
    pub lut_file_path: Option<String>,
    pub is_builtin: i64,
    pub category_id: Option<i64>,
    pub created_at: String,
}
```
- [ ] **Step 2.2: 替换 `NewFilterPreset` 结构体**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewFilterPreset {
    pub name: String,
    pub base_simulation: String,
    pub grain_effect: Option<String>,
    pub grain_size: Option<String>,
    pub color_chrome_effect: Option<String>,
    pub exposure: f64,
    pub contrast: i64,
    pub brightness: i64,
    pub highlight_tone: i64,
    pub shadow_tone: i64,
    pub white: i64,
    pub black: i64,
    pub dehaze: i64,
    pub vibrance: i64,
    pub color_saturation: i64,
    pub clarity: i64,
    pub sharpness: i64,
    pub wb_shift_r: i64,
    pub wb_shift_b: i64,
    pub lut_file_path: Option<String>,
    pub category_id: Option<i64>,
    pub is_builtin: bool,
}
```

- [ ] **Step 2.3: 重写 `upsert` SQL**

整体替换 `pub async fn upsert` 函数为：

```rust
pub async fn upsert(pool: &SqlitePool, p: &NewFilterPreset) -> Result<FilterPreset> {
    sqlx::query(
        r#"INSERT INTO filter_presets (name,base_simulation,grain_effect,grain_size,color_chrome_effect,exposure,contrast,brightness,highlight_tone,shadow_tone,white,black,dehaze,vibrance,color_saturation,clarity,sharpness,wb_shift_r,wb_shift_b,lut_file_path,is_builtin,category_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(name) DO UPDATE SET
             base_simulation=excluded.base_simulation,
             grain_effect=excluded.grain_effect,
             grain_size=excluded.grain_size,
             color_chrome_effect=excluded.color_chrome_effect,
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
    )
    .bind(&p.name).bind(&p.base_simulation).bind(&p.grain_effect)
    .bind(&p.grain_size).bind(&p.color_chrome_effect)
    .bind(p.exposure).bind(p.contrast).bind(p.brightness)
    .bind(p.highlight_tone).bind(p.shadow_tone)
    .bind(p.white).bind(p.black).bind(p.dehaze)
    .bind(p.vibrance).bind(p.color_saturation)
    .bind(p.clarity).bind(p.sharpness)
    .bind(p.wb_shift_r).bind(p.wb_shift_b)
    .bind(&p.lut_file_path).bind(p.is_builtin as i64)
    .bind(p.category_id)
    .execute(pool).await?;
    sqlx::query_as::<_, FilterPreset>("SELECT * FROM filter_presets WHERE name = ?")
        .bind(&p.name).fetch_one(pool).await.map_err(Into::into)
}
```

> 列数：22；`?` 个数：22；`.bind` 个数：22。手动数过一遍。
- [ ] **Step 2.4: 更新 `state.rs::seed_builtin_presets` 字面量**

`src-tauri/src/state.rs` 中 `NewFilterPreset { ... }` 字面量整体替换为：

```rust
        let preset = NewFilterPreset {
            name: (*name).to_string(),
            base_simulation: (*name).to_string(),
            grain_effect: None,
            grain_size: None,
            color_chrome_effect: None,
            exposure: 0.0,
            contrast: 0,
            brightness: 0,
            highlight_tone: 0,
            shadow_tone: 0,
            white: 0,
            black: 0,
            dehaze: 0,
            vibrance: 0,
            color_saturation: 0,
            clarity: 0,
            sharpness: 0,
            wb_shift_r: 0,
            wb_shift_b: 0,
            lut_file_path: None,
            category_id: None,
            is_builtin: true,
        };
```

- [ ] **Step 2.5: 编译 + clippy + test**

```bash
cd src-tauri && cargo build && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

注意：此时 `cargo test` 会**失败**，因为旧表 schema 与新结构体不匹配。这是预期的——Task 3 要做 schema 迁移。先继续 Task 3，完成后所有测试自然恢复。

如果 `cargo build` 失败：检查 `presets.rs` 内部是否还有用旧字段类型的辅助函数（应该没有），以及是否有其它处构造 `NewFilterPreset` 字面量（除了 `state.rs::seed_builtin_presets` 外应没有，可用 `grep -rn "NewFilterPreset {" src-tauri/src` 验证）。

- [ ] **Step 2.6: 提交（即使 cargo test 暂时失败）**

```bash
git add src-tauri/src/db/presets.rs src-tauri/src/state.rs
git -c commit.gpgsign=false commit -m "feat(db): expand FilterPreset schema with new tone fields"
```
---

### Task 3: 数据库 schema 迁移

**Files:**
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 3.1: 添加 DROP TABLE 迁移指令**

打开 `src-tauri/src/db/mod.rs`，在 `run_migrations` 函数中找到第一个 `for sql in [ ... ALTER TABLE ... ]` 数组（由 Task 1 of preset-categories 留下的累积迁移）。在该数组的**末尾**追加这一条：

```rust
"DROP TABLE IF EXISTS filter_presets",
```

> 这条 DROP 比同数组中的 ALTER TABLE 优先级高（数组按顺序执行）。运行后表被删除，紧接着 `SCHEMA` 常量中的 `CREATE TABLE IF NOT EXISTS filter_presets ...` 会重建该表。

- [ ] **Step 3.2: 替换 `SCHEMA` 中的 `filter_presets` DDL**

在 `const SCHEMA: &str = r#"..."#;` 内找到 `CREATE TABLE IF NOT EXISTS filter_presets (...)` 并整体替换为：

```sql
CREATE TABLE IF NOT EXISTS filter_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    base_simulation TEXT NOT NULL,
    grain_effect TEXT,
    grain_size TEXT,
    color_chrome_effect TEXT,
    exposure REAL NOT NULL DEFAULT 0,
    contrast INTEGER NOT NULL DEFAULT 0,
    brightness INTEGER NOT NULL DEFAULT 0,
    highlight_tone INTEGER NOT NULL DEFAULT 0,
    shadow_tone INTEGER NOT NULL DEFAULT 0,
    white INTEGER NOT NULL DEFAULT 0,
    black INTEGER NOT NULL DEFAULT 0,
    dehaze INTEGER NOT NULL DEFAULT 0,
    vibrance INTEGER NOT NULL DEFAULT 0,
    color_saturation INTEGER NOT NULL DEFAULT 0,
    clarity INTEGER NOT NULL DEFAULT 0,
    sharpness INTEGER NOT NULL DEFAULT 0,
    wb_shift_r INTEGER NOT NULL DEFAULT 0,
    wb_shift_b INTEGER NOT NULL DEFAULT 0,
    lut_file_path TEXT,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

> 之前这个表存在 `category_id` 列（来自 preset-categories feature），新版本直接保留在 schema 内，无需独立 ALTER。
- [ ] **Step 3.3: 顺手清理已过时的旧增量迁移**

`run_migrations` 增量迁移数组内可能还遗留 `"ALTER TABLE filter_presets ADD COLUMN category_id INTEGER"` 这一条（preset-categories feature 加的）。由于 Task 3.1 会先 DROP，再由 Task 3.2 的 SCHEMA 重建（已包含 category_id），这条 ALTER 会因列已存在而失败 → 被现有 `let _ = ...` 忽略，**保留**也不影响。无需删除。

- [ ] **Step 3.4: 编译 + clippy + test**

```bash
cd src-tauri && cargo build && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

预期：现在应该全部通过——schema 与 `FilterPreset` 字段一致。

- [ ] **Step 3.5: 提交**

```bash
git add src-tauri/src/db/mod.rs
git -c commit.gpgsign=false commit -m "feat(db): drop+recreate filter_presets with new tone columns"
```

---

### Task 4: `tone.rs` 模块（exposure / contrast / brightness / segments）

**Files:**
- Create: `src-tauri/src/processing/tone.rs`
- Modify: `src-tauri/src/processing/mod.rs` (declare module)

- [ ] **Step 4.1: 在 `processing/mod.rs` 声明模块**

打开 `src-tauri/src/processing/mod.rs`，在 `pub mod color;` 同级追加：

```rust
pub mod tone;
```
- [ ] **Step 4.2: 写 tone.rs 含失败测试**

新建 `src-tauri/src/processing/tone.rs`：

```rust
//! 基础色调操作：曝光、对比度、亮度，以及 highlight/shadow/white/black 四段加权曲线。
//!
//! 所有函数都对 `[0,1]` 浮点像素就地操作，输出统一 clamp 在 `[0,1]` 内。

/// 曝光：以 EV stops 为单位的全图增益。`stops=1.0` 等价于 ×2，`stops=-1.0` 等价于 ×0.5。
pub fn apply_exposure_pixel(r: f32, g: f32, b: f32, stops: f32) -> (f32, f32, f32) {
    if stops == 0.0 { return (r, g, b); }
    let gain = (2f32).powf(stops);
    (r * gain, g * gain, b * gain)
}

/// 亮度：线性 offset。`amount` ∈ [-100, 100]，full-scale ±0.5。
pub fn apply_brightness_pixel(r: f32, g: f32, b: f32, amount: i32) -> (f32, f32, f32) {
    if amount == 0 { return (r, g, b); }
    let off = amount as f32 / 200.0;
    (r + off, g + off, b + off)
}

/// 对比度：以 0.5 为锚点的线性放大。`amount` ∈ [-100, 100]。
pub fn apply_contrast_pixel(r: f32, g: f32, b: f32, amount: i32) -> (f32, f32, f32) {
    if amount == 0 { return (r, g, b); }
    let k = 1.0 + amount as f32 / 100.0;
    let f = |v: f32| (v - 0.5) * k + 0.5;
    (f(r), f(g), f(b))
}

/// Hermite smoothstep `3t²-2t³`。
fn cubic_falloff(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// 高光/阴影/白色/黑色：基于 luma 的 4 段加权曲线，保留色相。
/// 各 `amount` ∈ [-100, 100]。
pub fn apply_tone_segments_pixel(
    r: f32, g: f32, b: f32,
    highlight: i32, shadow: i32, white: i32, black: i32,
) -> (f32, f32, f32) {
    if highlight == 0 && shadow == 0 && white == 0 && black == 0 {
        return (r, g, b);
    }
    let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let mut delta = 0.0f32;
    if highlight != 0 && l > 0.7 {
        delta += (highlight as f32 / 100.0) * cubic_falloff((l - 0.7) / 0.3) * 0.3;
    }
    if white != 0 && l > 0.85 {
        delta += (white as f32 / 100.0) * cubic_falloff((l - 0.85) / 0.15) * 0.3;
    }
    if shadow != 0 && l < 0.3 {
        delta += (shadow as f32 / 100.0) * cubic_falloff((0.3 - l) / 0.3) * 0.3;
    }
    if black != 0 && l < 0.15 {
        delta += (black as f32 / 100.0) * cubic_falloff((0.15 - l) / 0.15) * 0.3;
    }
    if delta == 0.0 || l <= 0.0001 {
        return (r, g, b);
    }
    // 保色相：按 RGB 比例缩放，使 luma 增加 delta
    let scale = (l + delta) / l;
    (r * scale, g * scale, b * scale)
}
```
紧接上面继续追加 `#[cfg(test)] mod tests`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposure_zero_is_identity() {
        let (r, g, b) = apply_exposure_pixel(0.5, 0.4, 0.3, 0.0);
        assert!((r - 0.5).abs() < 1e-6 && (g - 0.4).abs() < 1e-6 && (b - 0.3).abs() < 1e-6);
    }

    #[test]
    fn exposure_one_stop_doubles() {
        let (r, _, _) = apply_exposure_pixel(0.25, 0.25, 0.25, 1.0);
        assert!((r - 0.5).abs() < 1e-6);
    }

    #[test]
    fn brightness_positive_lifts() {
        let (r, _, _) = apply_brightness_pixel(0.5, 0.5, 0.5, 100);
        assert!((r - 1.0).abs() < 1e-6);
    }

    #[test]
    fn contrast_positive_separates() {
        let (lo, _, _) = apply_contrast_pixel(0.0, 0.0, 0.0, 100);
        let (hi, _, _) = apply_contrast_pixel(1.0, 1.0, 1.0, 100);
        assert!(lo < 0.0 && hi > 1.0);
    }

    #[test]
    fn tone_segments_zero_is_identity() {
        let (r, g, b) = apply_tone_segments_pixel(0.5, 0.5, 0.5, 0, 0, 0, 0);
        assert_eq!((r, g, b), (0.5, 0.5, 0.5));
    }

    #[test]
    fn tone_segments_highlight_lifts_brights_only() {
        // luma 0.5 在中段，highlight 不应触发
        let (r, _, _) = apply_tone_segments_pixel(0.5, 0.5, 0.5, 100, 0, 0, 0);
        assert!((r - 0.5).abs() < 1e-3);
        // luma 0.9 在高光区
        let (r2, _, _) = apply_tone_segments_pixel(0.9, 0.9, 0.9, 100, 0, 0, 0);
        assert!(r2 > 0.9);
    }

    #[test]
    fn tone_segments_shadow_lifts_darks_only() {
        let (r, _, _) = apply_tone_segments_pixel(0.5, 0.5, 0.5, 0, 100, 0, 0);
        assert!((r - 0.5).abs() < 1e-3);
        let (r2, _, _) = apply_tone_segments_pixel(0.1, 0.1, 0.1, 0, 100, 0, 0);
        assert!(r2 > 0.1);
    }
}
```

- [ ] **Step 4.3: 跑测试**

```bash
cd src-tauri && cargo test processing::tone
```

预期：7 个测试全部 PASS。

- [ ] **Step 4.4: clippy + fmt**

```bash
cd src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings
```

- [ ] **Step 4.5: 提交**

```bash
git add src-tauri/src/processing/mod.rs src-tauri/src/processing/tone.rs
git -c commit.gpgsign=false commit -m "feat(processing): add tone module (exposure/contrast/brightness/segments)"
```
---

### Task 5: `saturation.rs` 模块（vibrance + saturation）

**Files:**
- Create: `src-tauri/src/processing/saturation.rs`
- Modify: `src-tauri/src/processing/mod.rs` (declare module)

- [ ] **Step 5.1: 在 `processing/mod.rs` 声明模块**

追加：
```rust
pub mod saturation;
```

- [ ] **Step 5.2: 写 saturation.rs**

新建 `src-tauri/src/processing/saturation.rs`：

```rust
//! 鲜艳度（vibrance）与饱和度（saturation）。两者都在 HSL 空间操作。
//! - vibrance：低饱和像素权重高，高饱和像素权重低。
//! - saturation：全局线性叠加。

use crate::processing::color::{hsl_to_rgb, rgb_to_hsl};

/// 鲜艳度：`amount` ∈ [-100, 100]。低饱和度像素被加权放大。
pub fn apply_vibrance_pixel(r: f32, g: f32, b: f32, amount: i32) -> (f32, f32, f32) {
    if amount == 0 { return (r, g, b); }
    let k = amount as f32 / 100.0;
    let (h, s, l) = rgb_to_hsl(r, g, b);
    let weight = (1.0 - s).powi(2);
    let s_new = (s + k * weight * s).clamp(0.0, 1.0);
    hsl_to_rgb(h, s_new, l)
}

/// 饱和度：`amount` ∈ [-100, 100]。全局加 `amount/100`。
pub fn apply_saturation_pixel(r: f32, g: f32, b: f32, amount: i32) -> (f32, f32, f32) {
    if amount == 0 { return (r, g, b); }
    let k = amount as f32 / 100.0;
    let (h, s, l) = rgb_to_hsl(r, g, b);
    let s_new = (s + k).clamp(0.0, 1.0);
    hsl_to_rgb(h, s_new, l)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vibrance_zero_is_identity() {
        let (r, g, b) = apply_vibrance_pixel(0.6, 0.4, 0.2, 0);
        assert!((r - 0.6).abs() < 1e-5 && (g - 0.4).abs() < 1e-5 && (b - 0.2).abs() < 1e-5);
    }

    #[test]
    fn saturation_zero_is_identity() {
        let (r, g, b) = apply_saturation_pixel(0.6, 0.4, 0.2, 0);
        assert!((r - 0.6).abs() < 1e-5 && (g - 0.4).abs() < 1e-5 && (b - 0.2).abs() < 1e-5);
    }

    #[test]
    fn vibrance_protects_high_saturation() {
        // 高饱和（红色）vs. 低饱和（淡灰红）vibrance=100 后，相对增量应低饱和的更大
        let high_in = (0.9, 0.1, 0.1);
        let low_in = (0.55, 0.5, 0.5);
        let (hr, _, _) = apply_vibrance_pixel(high_in.0, high_in.1, high_in.2, 100);
        let (lr, lg, lb) = apply_vibrance_pixel(low_in.0, low_in.1, low_in.2, 100);
        let high_delta = (hr - high_in.0).abs();
        let low_delta_total = (lr - low_in.0).abs() + (lg - low_in.1).abs() + (lb - low_in.2).abs();
        assert!(low_delta_total >= high_delta * 0.5);
    }
}
```

- [ ] **Step 5.3: 跑测试 + clippy + fmt**

```bash
cd src-tauri && cargo test processing::saturation && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings
```

预期：3 个测试 PASS。

- [ ] **Step 5.4: 提交**

```bash
git add src-tauri/src/processing/mod.rs src-tauri/src/processing/saturation.rs
git -c commit.gpgsign=false commit -m "feat(processing): add saturation module with vibrance"
```
---

### Task 6: `dehaze.rs` 模块（Dark Channel Prior + Guided Filter）

**Files:**
- Create: `src-tauri/src/processing/dehaze.rs`
- Modify: `src-tauri/src/processing/mod.rs` (declare module)

> 这是本任务最复杂的算法。函数对**整张图**做处理（不是单像素），输入/输出是 `&mut [f32]` (RGB 平铺缓冲)。

- [ ] **Step 6.1: 在 `processing/mod.rs` 声明模块**

```rust
pub mod dehaze;
```

- [ ] **Step 6.2: 写 dehaze.rs 骨架**

新建 `src-tauri/src/processing/dehaze.rs`，分 6 个函数：

```rust
//! Dark Channel Prior 去雾（He et al. 2009）+ Guided Filter 透射率平滑。
//!
//! 全图 RGB 操作，函数签名以 `&[f32]` / `&mut [f32]` 形式接收主缓冲。
//!
//! 用户值 `amount` ∈ [-100, 100]：
//! - 正向：去雾，结果朝 J = (I - A)/t + A 方向插值；
//! - 负向：加雾，结果朝灰阶融合方向插值。

use rayon::prelude::*;

const PATCH_RADIUS: i32 = 7;        // 15×15 patch
const OMEGA: f32 = 0.95;            // 保留少量雾感
const T_MIN: f32 = 0.1;             // 透射率下限
const GF_RADIUS: i32 = 20;          // guided filter box radius
const GF_EPS: f32 = 1e-3;

/// 入口：对 `buf`（RGB 平铺，长度 w*h*3）就地应用去雾，强度 amount ∈ [-100,100]。
pub fn apply_dehaze(buf: &mut [f32], w: u32, h: u32, amount: i32) {
    if amount == 0 { return; }
    let n = (w * h) as usize;
    let dark = compute_dark_channel(buf, w, h);
    let airlight = estimate_airlight(buf, &dark);
    let raw_t = transmission_map(buf, w, h, airlight);
    let guide = luminance(buf, n);
    let t = guided_filter(&guide, &raw_t, w, h, GF_RADIUS, GF_EPS);

    let k = amount as f32 / 100.0;
    if k > 0.0 {
        // 去雾：朝复原结果插值
        buf.par_chunks_mut(3).enumerate().for_each(|(i, px)| {
            let ti = t[i].max(T_MIN);
            for c in 0..3 {
                let j = (px[c] - airlight[c]) / ti + airlight[c];
                px[c] = px[c] * (1.0 - k) + j.clamp(0.0, 1.0) * k;
            }
        });
    } else {
        // 加雾：朝大气光融合
        let kk = -k;
        buf.par_chunks_mut(3).for_each(|px| {
            for c in 0..3 {
                let fog = px[c] * 0.7 + airlight[c] * 0.3;
                px[c] = (px[c] * (1.0 - kk) + fog * kk).clamp(0.0, 1.0);
            }
        });
    }
}
```
紧接着在同文件追加 6 个内部函数：

```rust
fn compute_dark_channel(buf: &[f32], w: u32, h: u32) -> Vec<f32> {
    let w_i = w as i32;
    let h_i = h as i32;
    let n = (w * h) as usize;
    let mut dark = vec![0f32; n];
    dark.par_chunks_mut(w as usize).enumerate().for_each(|(y, row)| {
        for x in 0..w_i {
            let mut m = f32::INFINITY;
            for dy in -PATCH_RADIUS..=PATCH_RADIUS {
                let ny = y as i32 + dy;
                if ny < 0 || ny >= h_i { continue; }
                for dx in -PATCH_RADIUS..=PATCH_RADIUS {
                    let nx = x + dx;
                    if nx < 0 || nx >= w_i { continue; }
                    let i = ((ny * w_i + nx) * 3) as usize;
                    m = m.min(buf[i]).min(buf[i + 1]).min(buf[i + 2]);
                }
            }
            row[x as usize] = m;
        }
    });
    dark
}

fn estimate_airlight(buf: &[f32], dark: &[f32]) -> [f32; 3] {
    // 取 dark channel 前 0.1% 最亮像素，对应 buf 中 RGB 最大亮度
    let n = dark.len();
    let take = (n / 1000).max(1);
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_by(|&a, &b| dark[b].partial_cmp(&dark[a]).unwrap());
    let mut best = [0f32; 3];
    let mut best_intensity = -1f32;
    for &i in idx.iter().take(take) {
        let r = buf[i * 3];
        let g = buf[i * 3 + 1];
        let b = buf[i * 3 + 2];
        let intensity = r + g + b;
        if intensity > best_intensity {
            best_intensity = intensity;
            best = [r, g, b];
        }
    }
    best
}

fn transmission_map(buf: &[f32], w: u32, h: u32, a: [f32; 3]) -> Vec<f32> {
    // 对 I/A 计算 dark channel，t = 1 - omega * darkchannel(I/A)
    let n = (w * h) as usize;
    let mut normalized = vec![0f32; n * 3];
    for i in 0..n {
        for c in 0..3 {
            normalized[i * 3 + c] = (buf[i * 3 + c] / a[c].max(1e-6)).clamp(0.0, 1.0);
        }
    }
    let dark = compute_dark_channel(&normalized, w, h);
    dark.iter().map(|d| (1.0 - OMEGA * d).clamp(0.0, 1.0)).collect()
}

fn luminance(buf: &[f32], n: usize) -> Vec<f32> {
    (0..n).map(|i| {
        0.2126 * buf[i * 3] + 0.7152 * buf[i * 3 + 1] + 0.0722 * buf[i * 3 + 2]
    }).collect()
}
```
继续追加 guided filter + 测试：

```rust
/// Guided Filter（He et al. 2010）。`guide` 为引导图（亮度），`p` 为输入信号（透射率）。
/// 输出为平滑后的透射率，长度 = w*h。
fn guided_filter(guide: &[f32], p: &[f32], w: u32, h: u32, r: i32, eps: f32) -> Vec<f32> {
    let mean_i = box_blur_1c(guide, w, h, r);
    let mean_p = box_blur_1c(p, w, h, r);
    let ip: Vec<f32> = guide.iter().zip(p).map(|(a, b)| a * b).collect();
    let mean_ip = box_blur_1c(&ip, w, h, r);
    let ii: Vec<f32> = guide.iter().map(|x| x * x).collect();
    let mean_ii = box_blur_1c(&ii, w, h, r);

    let n = guide.len();
    let mut a = vec![0f32; n];
    let mut b = vec![0f32; n];
    for i in 0..n {
        let var_i = mean_ii[i] - mean_i[i] * mean_i[i];
        let cov_ip = mean_ip[i] - mean_i[i] * mean_p[i];
        a[i] = cov_ip / (var_i + eps);
        b[i] = mean_p[i] - a[i] * mean_i[i];
    }
    let mean_a = box_blur_1c(&a, w, h, r);
    let mean_b = box_blur_1c(&b, w, h, r);
    (0..n).map(|i| mean_a[i] * guide[i] + mean_b[i]).collect()
}

fn box_blur_1c(src: &[f32], w: u32, h: u32, r: i32) -> Vec<f32> {
    let w_i = w as i32;
    let h_i = h as i32;
    let n = (w * h) as usize;
    let mut tmp = vec![0f32; n];
    tmp.par_chunks_mut(w as usize).enumerate().for_each(|(y, row)| {
        for x in 0..w_i {
            let mut sum = 0f32; let mut cnt = 0f32;
            for dx in -r..=r {
                let nx = x + dx;
                if nx >= 0 && nx < w_i {
                    sum += src[(y as i32 * w_i + nx) as usize];
                    cnt += 1.0;
                }
            }
            row[x as usize] = sum / cnt;
        }
    });
    let mut out = vec![0f32; n];
    out.par_chunks_mut(w as usize).enumerate().for_each(|(y, row)| {
        let y = y as i32;
        for x in 0..w_i {
            let mut sum = 0f32; let mut cnt = 0f32;
            for dy in -r..=r {
                let ny = y + dy;
                if ny >= 0 && ny < h_i {
                    sum += tmp[(ny * w_i + x) as usize];
                    cnt += 1.0;
                }
            }
            row[x as usize] = sum / cnt;
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthesize_hazy(w: u32, h: u32) -> Vec<f32> {
        // 中性灰加白雾：base 0.5，再朝 1.0 偏移 0.3
        let n = (w * h * 3) as usize;
        let mut buf = vec![0.5f32; n];
        for v in buf.iter_mut() { *v = *v * 0.7 + 0.3; }
        // 给中心区域注入一点低饱和细节
        for y in 30..50 { for x in 30..50 {
            let i = ((y * w + x) * 3) as usize;
            buf[i] = 0.4; buf[i + 1] = 0.4; buf[i + 2] = 0.5;
        }}
        buf
    }

    fn rgb_std(buf: &[f32]) -> f32 {
        let mean: f32 = buf.iter().sum::<f32>() / buf.len() as f32;
        let var: f32 = buf.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / buf.len() as f32;
        var.sqrt()
    }

    #[test]
    fn dehaze_zero_is_identity() {
        let mut buf = synthesize_hazy(80, 80);
        let copy = buf.clone();
        apply_dehaze(&mut buf, 80, 80, 0);
        assert_eq!(buf, copy);
    }

    #[test]
    fn dehaze_positive_increases_variance() {
        let mut buf = synthesize_hazy(80, 80);
        let before = rgb_std(&buf);
        apply_dehaze(&mut buf, 80, 80, 100);
        let after = rgb_std(&buf);
        assert!(after > before, "after std {} should exceed before {}", after, before);
    }
}
```

- [ ] **Step 6.3: 跑测试**

```bash
cd src-tauri && cargo test processing::dehaze
```

预期：2 个测试 PASS。`dehaze_positive_increases_variance` 在合成图上 std 至少要明显放大。

- [ ] **Step 6.4: clippy + fmt**

```bash
cd src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings
```

- [ ] **Step 6.5: 提交**

```bash
git add src-tauri/src/processing/mod.rs src-tauri/src/processing/dehaze.rs
git -c commit.gpgsign=false commit -m "feat(processing): add dehaze module (DCP + guided filter)"
```
---

### Task 7: 重写 `process_image` 编排（接入新模块）

**Files:**
- Modify: `src-tauri/src/processing/pipeline.rs`

> 这一任务把 Task 4/5/6 的算法接进主流水线，去掉 Task 1 留下的临时垫片，并按 spec §4.2 的 LR 顺序重新排列像素循环。

- [ ] **Step 7.1: 顶部 use 新模块**

`src-tauri/src/processing/pipeline.rs` 顶部 `use` 块中追加：

```rust
use crate::processing::tone::{
    apply_brightness_pixel, apply_contrast_pixel, apply_exposure_pixel,
    apply_tone_segments_pixel,
};
use crate::processing::saturation::{apply_saturation_pixel, apply_vibrance_pixel};
use crate::processing::dehaze::apply_dehaze;
```

- [ ] **Step 7.2: 移除 Task 1.4 加的临时垫片 + `#[allow(dead_code)]`**

把 Task 1 步骤 1.4 加的 `as f32 / 100.0` 临时转换全部还原为对新字段的直接读取（值是 i32，但下游算法接受 i32 amount）。删除 `#[allow(dead_code)]`。

- [ ] **Step 7.3: 重写像素循环**

把 `buf.par_chunks_mut(3).enumerate().for_each(|(idx, chunk)| { ... })` 整块替换。原顺序：WB → tone curve → split-toning → saturation → chrome → fade → mono → LUT。新顺序参考 spec §4.2：

```rust
    buf.par_chunks_mut(3).enumerate().for_each(|(idx, chunk)| {
        let px = src.get_pixel((idx as u32) % w, (idx as u32) / w);
        let mut r = u16_to_f(px.0[0]);
        let mut g = u16_to_f(px.0[1]);
        let mut b = u16_to_f(px.0[2]);

        // [1] WB shift
        let (nr, ng, nb) = color::apply_wb_shift(r, g, b, settings.wb_shift_r, settings.wb_shift_b);
        r = nr; g = ng; b = nb;

        // [2] Exposure
        let (nr, ng, nb) = apply_exposure_pixel(r, g, b, settings.exposure);
        r = nr; g = ng; b = nb;

        // [3] Brightness then Contrast
        let (nr, ng, nb) = apply_brightness_pixel(r, g, b, settings.brightness);
        r = nr; g = ng; b = nb;
        let (nr, ng, nb) = apply_contrast_pixel(r, g, b, settings.contrast);
        r = nr; g = ng; b = nb;

        // [4] Highlight / Shadow / White / Black 4-segment
        let (nr, ng, nb) = apply_tone_segments_pixel(
            r, g, b,
            settings.highlight_tone, settings.shadow_tone,
            settings.white, settings.black,
        );
        r = nr; g = ng; b = nb;

        // ===== 此处之后插入原有的 tone curve / split-toning / chrome / fade / mono / LUT 块 =====
        // (将旧像素循环中 [2]..[8] 整段原样保留，但 [4] 饱和度部分换成 Task 7.4 的新版)
        // ...
        chunk[0] = r.clamp(0.0, 1.0);
        chunk[1] = g.clamp(0.0, 1.0);
        chunk[2] = b.clamp(0.0, 1.0);
    });
```

> ⚠️ 完整替换实施细节：保留原循环里 `// [2] 分通道色调曲线` 到 `// [8] 外挂 3D LUT` 的代码块。把 `// [4] 饱和度` 部分（行 ~225-229）替换为对 `apply_vibrance_pixel` + `apply_saturation_pixel` 的两次调用。
- [ ] **Step 7.4: 替换饱和度块为 vibrance + saturation**

旧块（行 ~224-229）：
```rust
let sat_amount = profile.saturation + settings.color_saturation;
let (sr, sg, sb) = color::saturate(r, g, b, sat_amount);
r = sr; g = sg; b = sb;
```

换为：
```rust
// vibrance 先做（低饱和加权）
let (nr, ng, nb) = apply_vibrance_pixel(r, g, b, settings.vibrance);
r = nr; g = ng; b = nb;
// saturation 再做（全局）+ 富士 preset 的 saturation 偏移
if settings.color_saturation != 0 || profile.saturation != 0.0 {
    // 把 preset.saturation (-1..+1) 折算到 -100..+100，与用户 saturation 相加
    let combined = settings.color_saturation + (profile.saturation * 100.0) as i32;
    let (nr, ng, nb) = apply_saturation_pixel(r, g, b, combined);
    r = nr; g = ng; b = nb;
}
```

- [ ] **Step 7.5: 像素循环后插入 dehaze（在 LUT/clarity 之前）**

像素循环结束后，**先**调用 dehaze（spec §4.2 step 5 之后、tone curve 已在循环里完成、dehaze 必须在 RGB 全图阶段做）：

在 `buf.par_chunks_mut(3).enumerate().for_each(...)` 那块整段 `});` 之后、`let res_scale = ...` 之前，插入：

```rust
    // [5] Dehaze 在 RGB 全图阶段做，需要 dark-channel 与 guided-filter
    if settings.dehaze != 0 {
        apply_dehaze(&mut buf, w, h, settings.dehaze);
    }
```

- [ ] **Step 7.6: 更新 clarity / sharpness 的阈值与缩放**

行 ~273-280 现有：
```rust
if settings.clarity.abs() > 0.001 {
    let radius = (8.0 * res_scale).round() as i32;
    apply_clarity(&mut buf, w, h, settings.clarity, radius);
}
if settings.sharpness.abs() > 0.001 {
    let radius = (2.0 * res_scale).round() as i32;
    apply_unsharp(&mut buf, w, h, settings.sharpness, radius);
}
```

换为：
```rust
if settings.clarity != 0 {
    let radius = (8.0 * res_scale).round() as i32;
    apply_clarity(&mut buf, w, h, settings.clarity as f32 / 100.0, radius);
}
if settings.sharpness != 0 {
    let radius = (2.0 * res_scale).round() as i32;
    apply_unsharp(&mut buf, w, h, settings.sharpness as f32 / 100.0, radius);
}
```

- [ ] **Step 7.7: 更新 ToneCurve::build 参数转换**

行 ~133-137（用 highlight_tone 和 shadow_tone 构造 curve），把 `f32` 字段直接传改为 i32→f32 缩放：

```rust
let curve = ToneCurve::build(
    (settings.highlight_tone as f32 / 100.0) + profile.contrast * 0.0,
    settings.shadow_tone as f32 / 100.0,
    profile.contrast,
);
```

- [ ] **Step 7.8: cargo build / test / clippy / fmt**

```bash
cd src-tauri && cargo build && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

预期：全部通过。如有 unused import 警告（比如 `apply_dehaze` 引入路径），按 clippy 提示清理。

- [ ] **Step 7.9: 提交**

```bash
git add src-tauri/src/processing/pipeline.rs
git -c commit.gpgsign=false commit -m "feat(pipeline): wire new tone modules and apply LR-order pipeline"
```
---

## Phase 2：前端

### Task 8: 前端类型与默认值

**Files:**
- Modify: `src/types.ts`
- Modify: `src/store/defaults.ts`

- [ ] **Step 8.1: 更新 `FilterSettings`（`src/types.ts`）**

找到 `export type FilterSettings = { ... }` 块。替换为：

```ts
export type FilterSettings = {
  base_simulation: string;
  grain_effect?: string | null;
  grain_size?: string | null;
  color_chrome_effect?: string | null;
  exposure: number;
  contrast: number;
  brightness: number;
  highlight_tone: number;
  shadow_tone: number;
  white: number;
  black: number;
  dehaze: number;
  vibrance: number;
  color_saturation: number;
  clarity: number;
  sharpness: number;
  wb_shift_r: number;
  wb_shift_b: number;
  tone_curve?: ToneCurvePoints | null;
  lut_file_path?: string | null;
};
```

- [ ] **Step 8.2: 更新 `FilterPreset`**

类似地，把 `FilterPreset` 字段替换为下列（保留 id/name/created_at/is_builtin/category_id 等元字段）：

```ts
export type FilterPreset = {
  id: number;
  name: string;
  base_simulation: string;
  grain_effect?: string | null;
  grain_size?: string | null;
  color_chrome_effect?: string | null;
  exposure: number;
  contrast: number;
  brightness: number;
  highlight_tone: number;
  shadow_tone: number;
  white: number;
  black: number;
  dehaze: number;
  vibrance: number;
  color_saturation: number;
  clarity: number;
  sharpness: number;
  wb_shift_r: number;
  wb_shift_b: number;
  lut_file_path?: string | null;
  is_builtin: number;
  category_id?: number | null;
  created_at: string;
};
```

`NewFilterPreset` 通过 `Omit<FilterPreset, ...> & { is_builtin: boolean }` 自动跟随，无需改。

- [ ] **Step 8.3: 更新 `DEFAULT_FILTER`（`src/store/defaults.ts`）**

```ts
export const DEFAULT_FILTER: FilterSettings = {
  base_simulation: "Pass-Through",
  grain_effect: "None",
  grain_size: "Small",
  color_chrome_effect: "None",
  exposure: 0,
  contrast: 0,
  brightness: 0,
  highlight_tone: 0,
  shadow_tone: 0,
  white: 0,
  black: 0,
  dehaze: 0,
  vibrance: 0,
  color_saturation: 0,
  clarity: 0,
  sharpness: 0,
  wb_shift_r: 0,
  wb_shift_b: 0,
  lut_file_path: null,
  tone_curve: null,
};
```

- [ ] **Step 8.4: tsc 检查**

```bash
pnpm tsc --noEmit
```

预期：编译错误集中在 `FilterPanel.tsx`、`PreviewPanel.tsx`、`store/slices/filter.ts`——这些下个 Task 修。如果出现在其它地方（罕见），按提示补字段。

- [ ] **Step 8.5: 提交**

```bash
git add src/types.ts src/store/defaults.ts
git -c commit.gpgsign=false commit -m "feat(types): expand FilterSettings/Preset with new tone fields"
```
---

### Task 9: `presetToFilter` 同步 + PreviewPanel identity 检查

**Files:**
- Modify: `src/store/slices/filter.ts`
- Modify: `src/components/PreviewPanel.tsx`

- [ ] **Step 9.1: 重写 `presetToFilter`（`src/store/slices/filter.ts`）**

定位到 `function presetToFilter(preset: FilterPreset): FilterSettings { ... }` 并替换为：

```ts
function presetToFilter(preset: FilterPreset): FilterSettings {
  return {
    base_simulation: preset.base_simulation,
    grain_effect: preset.grain_effect ?? "None",
    grain_size: preset.grain_size ?? "Small",
    color_chrome_effect: preset.color_chrome_effect ?? "None",
    exposure: preset.exposure,
    contrast: preset.contrast,
    brightness: preset.brightness,
    highlight_tone: preset.highlight_tone,
    shadow_tone: preset.shadow_tone,
    white: preset.white,
    black: preset.black,
    dehaze: preset.dehaze,
    vibrance: preset.vibrance,
    color_saturation: preset.color_saturation,
    clarity: preset.clarity,
    sharpness: preset.sharpness,
    wb_shift_r: preset.wb_shift_r,
    wb_shift_b: preset.wb_shift_b,
    lut_file_path: preset.lut_file_path ?? null,
  };
}
```

- [ ] **Step 9.2: 更新 PreviewPanel identity 检查**

`src/components/PreviewPanel.tsx` 行 ~155-173 的 `const isIdentity = ...` 块。在现有条件之外补 7 个新字段判断：

```ts
const isIdentity =
  (filter.base_simulation === "Pass-Through" || !filter.base_simulation) &&
  !filter.lut_file_path &&
  filter.exposure === 0 &&
  filter.contrast === 0 &&
  filter.brightness === 0 &&
  filter.highlight_tone === 0 &&
  filter.shadow_tone === 0 &&
  filter.white === 0 &&
  filter.black === 0 &&
  filter.dehaze === 0 &&
  filter.vibrance === 0 &&
  filter.color_saturation === 0 &&
  filter.clarity === 0 &&
  filter.sharpness === 0 &&
  filter.wb_shift_r === 0 &&
  filter.wb_shift_b === 0 &&
  (!filter.grain_effect || filter.grain_effect === "None") &&
  (!filter.color_chrome_effect || filter.color_chrome_effect === "None") &&
  (!filter.tone_curve || (
    filter.tone_curve.rgb.length === 0 &&
    filter.tone_curve.r.length === 0 &&
    filter.tone_curve.g.length === 0 &&
    filter.tone_curve.b.length === 0
  ));
```

- [ ] **Step 9.3: tsc + build**

```bash
pnpm tsc --noEmit && pnpm build
```

预期：tsc 仍有错误（FilterPanel 还没改），但 PreviewPanel 与 filter slice 不该再报错。如果它们仍报错，按提示补字段。

- [ ] **Step 9.4: 提交**

```bash
git add src/store/slices/filter.ts src/components/PreviewPanel.tsx
git -c commit.gpgsign=false commit -m "feat(store): sync presetToFilter and PreviewPanel identity with new fields"
```
---

### Task 10: i18n 新增 + 删除胶片模拟相关 key

**Files:**
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 10.1: 新增 7 条 key（zh）**

在 `src/i18n/zh.ts` 的 `filterPanel: { ... }` 内追加：

```ts
exposure: "曝光",
contrast: "对比度",
brightness: "亮度",
white: "白色",
black: "黑色",
dehaze: "祛雾",
vibrance: "鲜艳度",
```

- [ ] **Step 10.2: 删除已废弃 key（zh）**

在 `filterPanel:` 内删除：
- `filmSimulation: "胶片模拟",`
- `noSimulation: "无",`
- `systemPresets: "系统预设",`
- `userPresets: "用户自定义",`

（如果还有 `importLut` / `importFiles` / `importDir` / `lutAppliedNotice`，**保留** `lutAppliedNotice`，其它已在 preset-categories feature 中删除。grep 确认。）

- [ ] **Step 10.3: 同步 en（`src/i18n/en.ts`）**

新增：
```ts
exposure: "Exposure",
contrast: "Contrast",
brightness: "Brightness",
white: "Whites",
black: "Blacks",
dehaze: "Dehaze",
vibrance: "Vibrance",
```

删除同名旧 key。

- [ ] **Step 10.4: tsc**

```bash
pnpm tsc --noEmit
```

i18n 文件本身不报类型错误（key 是动态字符串）。`FilterPanel.tsx` 仍会报错——下一个 task 修。

- [ ] **Step 10.5: 提交**

```bash
git add src/i18n/zh.ts src/i18n/en.ts
git -c commit.gpgsign=false commit -m "feat(i18n): add tone control labels, remove film simulation labels"
```
---

### Task 11: 重组 FilterPanel — 删胶片模拟下拉，加 11 个 SliderRow

**Files:**
- Modify: `src/components/FilterPanel.tsx`

> 这是前端最重的任务，但相对机械：把现有 5 个 SliderRow 升级到 -100/+100，再加 7 个新 SliderRow，重组 Section 划分。

- [ ] **Step 11.1: 删除胶片模拟相关代码**

在 `src/components/FilterPanel.tsx`：
- 顶部删除 `const FUJI_PREFIX = "fuji:";`（如还存在；preset-categories 移除 LUT_PREFIX 时可能未连带删除 FUJI_PREFIX）
- 删除 `selectedValue` 与 `handleSimulationChange` 函数（这些只为「胶片模拟」下拉服务）
- 删除「基础」Section 内整段 `<Label>{t("filterPanel.filmSimulation")}</Label> <Select ...>...</Select>` 与下方的 `lutAppliedNotice` 段落

  ⚠️ `lutAppliedNotice` 段保留——它依赖 `filter.base_simulation === PASS_THROUGH_SIM && filter.lut_file_path` 提示用户当前应用了 LUT。此 notice 与「基础」Section 内容并列即可，不需要原下拉。
- 删除 `import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue }`（如仍 unused，由 tsc 提示）

- [ ] **Step 11.2: 「基础」Section 替换为 3 个 SliderRow**

```tsx
<Section title={t("editor.sections.basic")}>
  {filter.base_simulation === PASS_THROUGH_SIM && filter.lut_file_path && (
    <p className="mb-2 text-[10px] text-zinc-500">{t("filterPanel.lutAppliedNotice")}</p>
  )}
  <SliderRow
    label={t("filterPanel.exposure")}
    value={filter.exposure}
    min={-5} max={5} step={0.05}
    display={(v) => v.toFixed(2)}
    onChange={(v) => setFilter({ exposure: v })}
  />
  <SliderRow
    label={t("filterPanel.contrast")}
    value={filter.contrast}
    min={-100} max={100} step={1}
    display={(v) => v.toFixed(0)}
    onChange={(v) => setFilter({ contrast: v })}
  />
  <SliderRow
    label={t("filterPanel.brightness")}
    value={filter.brightness}
    min={-100} max={100} step={1}
    display={(v) => v.toFixed(0)}
    onChange={(v) => setFilter({ brightness: v })}
  />
</Section>
```
- [ ] **Step 11.3: 「光线」Section 重组（5 个 SliderRow，全部 -100/+100）**

```tsx
<Section title={t("editor.sections.light")}>
  <SliderRow label={t("filterPanel.highlight")} value={filter.highlight_tone} min={-100} max={100} step={1} display={(v) => v.toFixed(0)} onChange={(v) => setFilter({ highlight_tone: v })} />
  <SliderRow label={t("filterPanel.shadow")}    value={filter.shadow_tone}    min={-100} max={100} step={1} display={(v) => v.toFixed(0)} onChange={(v) => setFilter({ shadow_tone: v })} />
  <SliderRow label={t("filterPanel.white")}     value={filter.white}          min={-100} max={100} step={1} display={(v) => v.toFixed(0)} onChange={(v) => setFilter({ white: v })} />
  <SliderRow label={t("filterPanel.black")}     value={filter.black}          min={-100} max={100} step={1} display={(v) => v.toFixed(0)} onChange={(v) => setFilter({ black: v })} />
  <SliderRow label={t("filterPanel.dehaze")}    value={filter.dehaze}         min={-100} max={100} step={1} display={(v) => v.toFixed(0)} onChange={(v) => setFilter({ dehaze: v })} />
</Section>
```

- [ ] **Step 11.4: 「颜色」Section 重组**

```tsx
<Section title={t("editor.sections.color")}>
  <SliderRow label={t("filterPanel.vibrance")}   value={filter.vibrance}         min={-100} max={100} step={1} display={(v) => v.toFixed(0)} onChange={(v) => setFilter({ vibrance: v })} />
  <SliderRow label={t("filterPanel.saturation")} value={filter.color_saturation} min={-100} max={100} step={1} display={(v) => v.toFixed(0)} onChange={(v) => setFilter({ color_saturation: v })} />
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
```

⚠️ Step 11.1 删除 `Select` 导入后，「颜色」Section 还在用，要还原导入。grep 确认。

- [ ] **Step 11.5: 「细节」Section 改 -100/+100**

`<Section title={t("editor.sections.detail")}>` 内现有 SliderRow 把 `min={-1} max={1} step={0.05}` 改为 `min={-100} max={100} step={1}`，display 由 `v.toFixed(2)` 改 `v.toFixed(0)`。

- [ ] **Step 11.6: 「效果」Section 不变（颗粒强度 / 颗粒大小）**

仅检查无误，不动代码。

- [ ] **Step 11.7: tsc + build**

```bash
pnpm tsc --noEmit && pnpm build
```

预期：全部通过。

- [ ] **Step 11.8: 启动 dev 手测**

```bash
pnpm tauri dev
```

打开任意照片，「调整」tab 应显示 6 个 Section（基础 / 光线 / 颜色 / 效果 / 细节 / 色调曲线），各滑块拖动预览实时变化。胶片模拟下拉应消失。Ctrl+C 停止。

- [ ] **Step 11.9: 提交**

```bash
git add src/components/FilterPanel.tsx
git -c commit.gpgsign=false commit -m "feat(filter-panel): reorganize sections with 11 LR-style tone controls"
```
---

### Task 12: 全量验收 + 端到端 smoke

**Files:** 无文件改动。

- [ ] **Step 12.1: 后端全量验证**

```bash
cd src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

预期：全过。新增测试统计：tone 7 + saturation 3 + dehaze 2 = 12 个新单测，加上原有的 12 个 → 至少 24 个。

- [ ] **Step 12.2: 前端全量验证**

```bash
pnpm tsc --noEmit && pnpm build
```

预期：通过。

- [ ] **Step 12.3: 端到端 smoke**

```bash
pnpm tauri dev
```

按 spec §7 验证：

1. 「调整」tab 显示 6 个 Section（基础 / 光线 / 颜色 / 效果 / 细节 / 色调曲线）
2. 基础：曝光（-5/+5，两位小数）、对比度、亮度（-100/+100，整数）
3. 光线：高光、阴影、白色、黑色、祛雾（全部 -100/+100）
4. 颜色：鲜艳度、饱和度（-100/+100）+ 色彩效果 + 色温 R/B（-9/+9）
5. 细节：清晰度、锐度（-100/+100）
6. 各滑块拖动预览实时变化、范围正确显示
7. 「胶片模拟」下拉已完全消失
8. 保存预设到「我的」分类，看到完整字段持久化
9. 重启应用：13 个内置预设在「推荐」tab，自定义预设清空（spec §5 已确认接受）

Ctrl+C 停止。

- [ ] **Step 12.4: 文件行数复核**

```bash
wc -l src-tauri/src/processing/pipeline.rs src-tauri/src/processing/tone.rs src-tauri/src/processing/dehaze.rs src-tauri/src/processing/saturation.rs src-tauri/src/components/FilterPanel.tsx
```

预期：全部 < 500 行。

- [ ] **Step 12.5: 如有最后修复**

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
| 1 | FilterSettings 字段重定义（i32 范围 + 7 个新字段） |
| 2 | db::presets 结构体扩展 + upsert SQL |
| 3 | 数据库 DROP+CREATE filter_presets |
| 4 | tone.rs（exposure / contrast / brightness / segments） |
| 5 | saturation.rs（vibrance / saturation） |
| 6 | dehaze.rs（DCP + guided filter） |
| 7 | pipeline.rs 重写编排（LR 顺序） |
| 8 | 前端 types + DEFAULT_FILTER |
| 9 | presetToFilter + PreviewPanel identity |
| 10 | i18n（zh + en） |
| 11 | FilterPanel 重组 Section + 11 个 SliderRow |
| 12 | 全量验收 + e2e smoke |

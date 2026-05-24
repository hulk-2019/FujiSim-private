# 调整面板色调控件扩展 设计文档

- 日期：2026-05-24
- 范围：编辑页右侧「调整」tab、`processing` pipeline、`filter_presets` 表
- 状态：设计已确认，等待实现

## 1. 背景

「调整」tab 当前的「基础」Section 仅承载「胶片模拟」下拉。该下拉在 `PresetList`
预设面板上线后已被取代，长期占位无意义。同时，现有色调参数仅有 5 项
（高光、阴影、清晰度、锐度、饱和度），用户难以做精细的曝光与色调塑形。

本期目标：

1. 移除「基础」Section 中的胶片模拟下拉。
2. 引入 Lightroom 风格的 11 个色调参数（曝光、对比度、亮度、高光、阴影、白色、
   黑色、清晰度、祛雾、鲜艳度、饱和度），后端 pipeline 完整生效。
3. 重新组织「调整」tab 的 Section 分组，与 LR 语义一致。

## 2. 用户故事

1. 我要在「基础」里看到曝光、对比度、亮度三条核心控件。
2. 我要在「光线」里调整高光、阴影、白色、黑色、祛雾。
3. 我要在「颜色」里调整鲜艳度、饱和度，色温与色彩效果保留原位。
4. 拖动滑块时预览要实时跟随，无明显卡顿。
5. 内置 13 个胶片模拟在数据库重置后自动回填，可直接应用。

## 3. 参数表

| 参数 | 字段名 | 范围 | 步长 | 显示 | 后端类型 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 曝光 | `exposure` | -5.0 / +5.0 | 0.05 | `0.00` | `f32` | 新增 |
| 对比度 | `contrast` | -100 / +100 | 1 | 整数 | `i32` | 新增 |
| 亮度 | `brightness` | -100 / +100 | 1 | 整数 | `i32` | 新增 |
| 高光 | `highlight_tone` | -100 / +100 | 1 | 整数 | `i32` | 类型/范围迁移 |
| 阴影 | `shadow_tone` | -100 / +100 | 1 | 整数 | `i32` | 类型/范围迁移 |
| 白色 | `white` | -100 / +100 | 1 | 整数 | `i32` | 新增 |
| 黑色 | `black` | -100 / +100 | 1 | 整数 | `i32` | 新增 |
| 祛雾 | `dehaze` | -100 / +100 | 1 | 整数 | `i32` | 新增（DCP 算法） |
| 鲜艳度 | `vibrance` | -100 / +100 | 1 | 整数 | `i32` | 新增 |
| 饱和度 | `color_saturation` | -100 / +100 | 1 | 整数 | `i32` | 类型/范围迁移 |
| 清晰度 | `clarity` | -100 / +100 | 1 | 整数 | `i32` | 类型/范围迁移 |
| 锐度 | `sharpness` | -100 / +100 | 1 | 整数 | `i32` | 类型/范围迁移 |

未列出的字段（base_simulation、grain_*、color_chrome_effect、wb_shift_*、
tone_curve、lut_file_path）保持现状不变。

## 4. 后端 pipeline

### 4.1 数据结构

`src-tauri/src/processing/pipeline.rs::FilterSettings`：

```rust
pub struct FilterSettings {
    pub base_simulation: String,
    pub grain_effect: Option<String>,
    pub grain_size: Option<String>,
    pub color_chrome_effect: Option<String>,
    pub exposure: f32,            // -5.0..=5.0
    pub contrast: i32,            // -100..=100
    pub brightness: i32,
    pub highlight_tone: i32,
    pub shadow_tone: i32,
    pub white: i32,
    pub black: i32,
    pub dehaze: i32,
    pub vibrance: i32,
    pub color_saturation: i32,
    pub clarity: i32,
    pub sharpness: i32,
    pub wb_shift_r: i32,
    pub wb_shift_b: i32,
    pub tone_curve: Option<ToneCurvePoints>,
    pub lut_file_path: Option<PathBuf>,
}
```

`is_identity` 判定要把所有新字段为 0 纳入条件，保证默认设置仍能短路返回原图。

### 4.2 处理顺序（LR-style）

```
1. WB shift                                      （线性空间）
2. Exposure                                      （线性空间，2^EV 全图增益）
3. Contrast / Brightness                         （线性空间，sigmoid + offset）
4. Highlight / Shadow / White / Black            （tone segments，cubic falloff）
5. Dehaze                                        （DCP + guided filter）
6. Tone curve（用户自定义）+ split-toning + 富士 simulation
7. Vibrance / Saturation                         （HSL，vibrance 对低饱和加权）
8. Color chrome / fade / mono
9. LUT
10. Clarity（局部 USM）+ Sharpness
11. Grain（最后混合）
```

### 4.3 算法摘要

**Exposure**：`out = in * 2^exposure`，全图线性增益。

**Brightness**：`out = clamp(in + brightness/200.0, 0, 1)`。

**Contrast**：以 0.5 为锚点的线性放大，`out = clamp((in - 0.5) * (1 + contrast/100.0) + 0.5, 0, 1)`。

**Highlight / Shadow / White / Black**：基于像素 luma 的 4 段加权曲线。

- highlight 影响 `luma > 0.7`，权重 `cubic_falloff((luma - 0.7) / 0.3)`
- white 影响 `luma > 0.85`
- shadow 影响 `luma < 0.3`
- black 影响 `luma < 0.15`
- 用 cubic falloff `t -> 3t² - 2t³` 平滑过渡，避免色带。
- 数值贡献量为 `(amount / 100) * weight * 0.3`，叠加到原 luma 上后做 RGB 复原（保色相）。

**Dehaze（Dark Channel Prior + Guided Filter）**：

1. 计算 dark channel：每个 15×15 block 取 RGB 三通道最小值。
2. 估计大气光 A：dark channel 前 0.1% 最亮像素对应的原图 RGB 平均。
3. 透射率 `t(x) = 1 - ω · darkchannel(I/A)`，ω = 0.95。
4. 用 guided filter（box 半径 r=20、ε=0.001）平滑 t（避免 halo）。
5. 复原：`J = (I - A) / max(t, t_min) + A`，t_min = 0.1。
6. 用户值 dehaze ∈ [-100,+100]：
   - 正向加强去雾：`out = lerp(in, dehaze_result, dehaze/100)`
   - 负向加雾（low contrast）：`out = lerp(in, fog_overlay, -dehaze/100)`，
     fog_overlay 即 `lerp(in, vec3(A), 0.3)`。

**Vibrance**：HSL 空间，对低饱和像素加权：

```
sat_in  = HSL.s
boost   = (vibrance / 100) * (1 - sat_in)^2
sat_out = clamp(sat_in + boost * sat_in, 0, 1)
```

**Saturation**：HSL.s 全局加 `saturation/100`。

**Clarity / Sharpness**：现有 `apply_clarity` 公式，amount 由 `value/100` 给出，
其余不变。

### 4.4 性能预算（1280px 预览）

| 步骤 | 预算 |
| --- | --- |
| Exposure | 1ms |
| Contrast / Brightness | 1ms |
| Tone segments (HL/SH/W/B) | 3ms |
| Dehaze (DCP + GF) | 30ms |
| Vibrance / Saturation | 2ms |
| Clarity / Sharpness | 5ms |
| **合计** | ~45ms |

导出全分辨率（24MP）约 1–2s，作为后台任务可接受。

### 4.5 文件拆分

新增：

- `src-tauri/src/processing/tone.rs` ~200 行
  - `apply_exposure(buf)`、`apply_contrast(buf)`、`apply_brightness(buf)`、
    `apply_tone_segments(buf, hl, sh, w, b)`
- `src-tauri/src/processing/dehaze.rs` ~250 行
  - `dark_channel(rgb)`、`estimate_airlight(rgb, dark)`、
    `transmission_map(rgb, A, omega)`、`guided_filter(t, guide)`、
    `apply_dehaze(buf, amount)`
- `src-tauri/src/processing/saturation.rs` ~80 行
  - `apply_vibrance(buf)`、`apply_saturation(buf)`

修改：

- `src-tauri/src/processing/pipeline.rs`：当前 384 行 → ~250 行（核心
  `process_image` 编排，把算法实现挪到子模块）
- `src-tauri/src/processing/mod.rs`：声明三个新模块

每个文件均控制在 500 行以内。

## 5. 数据库迁移

放弃历史包袱。`db/mod.rs::run_migrations` 增加：

```rust
"DROP TABLE IF EXISTS filter_presets",
```

随后让 `SCHEMA` 内的 `CREATE TABLE IF NOT EXISTS filter_presets ...` 重建。
新 schema：

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

副作用：

- ✅ 13 个内置预设由 `state.rs::seed_builtin_presets` 启动时回填
- ❌ 用户自定义预设全部丢失（已确认接受）
- ❌ 用户分类对预设的引用失效，分类表本身保留；新表 `category_id` 全 NULL，
  PresetGroupedList 自动 fallback 到「未分类」组

`Cargo.lock` 与 `presets.rs` 的 `FilterPreset` / `NewFilterPreset` 结构体补
所有新字段。`state.rs::seed_builtin_presets` 的 13 个字面量补 `exposure: 0.0`、
`contrast: 0`、`brightness: 0`、`white: 0`、`black: 0`、`dehaze: 0`、
`vibrance: 0` 七个新字段。

`presets::upsert` 的 INSERT 列表 + ON CONFLICT 子句要包含全部新字段。bind
顺序与列顺序一一对应。

## 6. 前端

### 6.1 类型与默认值

`src/types.ts::FilterSettings` 与 `FilterPreset` 同步加 11 个字段。

`src/store/defaults.ts::DEFAULT_FILTER` 全部 0 默认。

`src/store/slices/filter.ts::presetToFilter` 把新字段从 preset 拷到 filter。

### 6.2 FilterPanel 重组

`src/components/FilterPanel.tsx` 重新分 Section：

```
基础（editor.sections.basic）
  曝光      SliderRow min=-5 max=5 step=0.05 display=v.toFixed(2)
  对比度    SliderRow min=-100 max=100 step=1 display=v.toFixed(0)
  亮度      同上

光线（editor.sections.light）
  高光  阴影  白色  黑色  祛雾   ── 全部 -100/+100 step=1

颜色（editor.sections.color）
  鲜艳度  饱和度                    ── -100/+100 step=1
  色彩效果（enum 不变）
  色温 R / 色温 B（-9/+9 不变）

效果（editor.sections.effects）
  颗粒强度 / 颗粒大小（不变）

细节（editor.sections.detail）
  清晰度  锐度                      ── -100/+100 step=1

色调曲线（editor.sections.curves，不变）
```

「胶片模拟」下拉与 `selectedValue` / `handleSimulationChange` 相关代码全部
删除。`FUJI_PREFIX` 常量随之删除。`PASS_THROUGH_SIM` 仍用于 LUT applied
notice 判断。

### 6.3 i18n

`src/i18n/zh.ts` / `en.ts` 新增 `filterPanel` 下：

```
exposure        "曝光" / "Exposure"
contrast        "对比度" / "Contrast"
brightness      "亮度" / "Brightness"
white           "白色" / "Whites"
black           "黑色" / "Blacks"
dehaze          "祛雾" / "Dehaze"
vibrance        "鲜艳度" / "Vibrance"
```

`filmSimulation`、`noSimulation`、`systemPresets`、`userPresets` 等被删除入口
对应的 key 一并清理。

### 6.4 IPC

`save_preset` IPC 透传整个 `NewFilterPreset`，无需改命令签名。`api.ts` 自动跟随
类型。

## 7. 测试

### 7.1 后端单元测试

`tests/pipeline_smoke.rs`（或 `processing/pipeline.rs` 内部 `#[cfg(test)]`）：

- `pipeline_runs_default`：默认设置下 process_image 走 identity 短路，输出 ==
  输入。
- `exposure_doubles_at_one_ev`：合成中灰图，exposure=1.0 后均值接近 2x。
- `contrast_at_extremes_clamps`：contrast=100 不应越界。
- `tone_segments_no_band`：highlight=100 在亮区单调增长，不出现回弹。
- `dehaze_increases_dynamic_range`：合成低对比图，dehaze=100 后 RGB std 增大。
- `dehaze_zero_is_identity`：dehaze=0 输出 == 输入。
- `vibrance_protects_high_sat`：高饱和像素 vibrance=100 后变化小于低饱和像素。

### 7.2 前端

项目无 vitest，跳过 React 单测；依赖 `pnpm tsc --noEmit` 与 `pnpm build` 类型/
构建保障。手动 smoke：

1. 启动 `pnpm tauri dev`，打开任意照片
2. 「调整」tab 看到 6 个 section（基础 / 光线 / 颜色 / 效果 / 细节 / 色调曲线）
3. 各滑块拖动预览实时变化、范围正确显示
4. 曝光显示两位小数，其它显示整数
5. 「胶片模拟」下拉已无
6. 保存预设到「我的」里看到完整字段
7. 重启应用：13 个内置预设仍在「推荐」tab，自定义预设清空

## 8. 风险

1. **Pipeline 性能回归**：dehaze 30–50ms 在 1280px 预览可接受；导出 24MP
   全分辨率 1–2s，后台任务无感。
2. **Drop+Create 中途崩溃**：DROP 完成后 CREATE 之前应用退出会留下空表，下次
   启动 `CREATE TABLE IF NOT EXISTS` 会重建，`seed_builtin_presets` 回填，无
   长期副作用。
3. **算法效果**：dehaze 与 LR 仍有差距（dark channel 在天空区域容易过去雾，
   guided filter 已缓解）。可接受。
4. **预设分类失联**：drop 表后所有 category_id 全 NULL，PresetGroupedList 自动
   fallback 到「未分类」组；前端无报错。
5. **既有 preset 调用方**：`store/slices/filter.ts::presetToFilter` 必须同步加
   字段，否则 applyPreset 会丢字段。设计已包含。

## 9. 文件清单

新建：

- `src-tauri/src/processing/tone.rs`
- `src-tauri/src/processing/dehaze.rs`
- `src-tauri/src/processing/saturation.rs`

修改：

- `src-tauri/src/processing/pipeline.rs`
- `src-tauri/src/processing/mod.rs`
- `src-tauri/src/db/mod.rs`
- `src-tauri/src/db/presets.rs`
- `src-tauri/src/state.rs`
- `src/types.ts`
- `src/store/defaults.ts`
- `src/store/slices/filter.ts`
- `src/components/FilterPanel.tsx`
- `src/i18n/zh.ts`
- `src/i18n/en.ts`

预计每个文件均控制在 500 行硬限以内。

## 10. 范围外

- 局部调整（径向 / 渐变 / 画笔）。
- 色相 / 饱和度 / 明度的 8 个色相分通道（HSL panel）。
- 镜头校正、降噪。
- 预设的导入 / 导出（JSON 文件）。
- 与现有 LUT、tone curve 的相互独立性已由 pipeline 顺序保证，不再展开。

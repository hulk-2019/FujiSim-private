# HSL 色彩调节功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在侧栏新增 HSL tab，实现 8 色相范围 × 3 属性（色相/饱和度/明度）的软边界 HSL 调节功能。

**Architecture:** FilterSettings 新增 24 个扁平 f32 字段；Rust 新增 `hsl_adjust` 模块处理 CPU 路径，GPU shader 同步加入 HSL 步骤；前端新增 HSL tab 含 3 个子 tab。

**Tech Stack:** Rust (rayon, wgpu), React/TypeScript, Radix Tabs, Zustand, Tauri IPC

---

## File Structure

### Rust Backend (Create/Modify)
- Create: `src-tauri/src/processing/hsl_adjust.rs` — HSL 调节核心算法
- Modify: `src-tauri/src/processing/mod.rs` — 注册新模块
- Modify: `src-tauri/src/processing/pipeline.rs` — 在 step 7 后插入 HSL 调用
- Modify: `src-tauri/src/processing/is_identity.rs` — 加入 24 个字段判断
- Modify: `src-tauri/src/processing/gpu/uniforms.rs` — FilterUniforms 新增 24 字段
- Modify: `src-tauri/src/processing/gpu/passes/color_fused.rs` — 传入新 uniform 偏移
- Modify: `src-tauri/src/processing/gpu/shaders/color_fused.wgsl` — WGSL HSL 调节逻辑

### Frontend (Create/Modify)
- Create: `src/components/HslPanel.tsx` — HSL tab 面板组件
- Modify: `src/types.ts` — FilterSettings 新增 24 字段
- Modify: `src/store/defaults.ts` — 默认值
- Modify: `src/components/FilterPanel.tsx` — 新增 HSL tab
- Modify: `src/i18n/en.ts` — 英文翻译
- Modify: `src/i18n/zh.ts` — 中文翻译

---

### Task 1: Rust — 新增 hsl_adjust 模块

**Files:**
- Create: `src-tauri/src/processing/hsl_adjust.rs`
- Modify: `src-tauri/src/processing/mod.rs`

- [ ] **Step 1: 创建 hsl_adjust.rs，编写单元测试**

```rust
// src-tauri/src/processing/hsl_adjust.rs

use crate::processing::color::{hsl_to_rgb, rgb_to_hsl};

/// 8 个色相范围的中心色相值（度）
const HSL_CENTERS: [f32; 8] = [0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0];

/// 高斯权重标准差
const SIGMA: f32 = 30.0;
const INV_2_SIGMA_SQ: f32 = 1.0 / (2.0 * SIGMA * SIGMA);

/// HSL 调节参数：24 个值，按 [hue0,sat0,lum0, hue1,sat1,lum1, ...] 排列
/// 8 组依次为 Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta
pub struct HslParams {
    /// 色相偏移 (-180..180)，8 个
    pub hue_shifts: [f32; 8],
    /// 饱和度偏移 (-100..100)，8 个
    pub sat_shifts: [f32; 8],
    /// 明度偏移 (-100..100)，8 个
    pub lum_shifts: [f32; 8],
}

impl HslParams {
    pub fn is_identity(&self) -> bool {
        self.hue_shifts.iter().all(|&v| v == 0.0)
            && self.sat_shifts.iter().all(|&v| v == 0.0)
            && self.lum_shifts.iter().all(|&v| v == 0.0)
    }
}

/// 计算色相到某个中心的环绕距离
fn hue_distance(h: f32, center: f32) -> f32 {
    let d = (h - center).abs();
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

/// 对像素缓冲区应用 HSL 调节。buf 为 RGBA f32 行优先。
pub fn apply_hsl_adjust(buf: &mut [f32], params: &HslParams) {
    buf.par_chunks_mut(4).for_each(|px| {
        let (h, s, l) = rgb_to_hsl(px[0], px[1], px[2]);

        // 计算各范围权重
        let mut weights = [0.0f32; 8];
        let mut weight_sum = 0.0f32;
        for i in 0..8 {
            let dist = hue_distance(h, HSL_CENTERS[i]);
            let w = (-dist * dist * INV_2_SIGMA_SQ).exp();
            weights[i] = w;
            weight_sum += w;
        }

        if weight_sum <= 0.0 {
            return;
        }

        let inv_sum = 1.0 / weight_sum;

        // 加权混合色相偏移
        let mut hue_delta = 0.0f32;
        let mut sat_delta = 0.0f32;
        let mut lum_delta = 0.0f32;
        for i in 0..8 {
            let w = weights[i] * inv_sum;
            hue_delta += params.hue_shifts[i] * w;
            sat_delta += params.sat_shifts[i] * w;
            lum_delta += params.lum_shifts[i] * w;
        }

        // 应用偏移
        let new_h = ((h + hue_delta) % 360.0 + 360.0) % 360.0;
        let new_s = (s + sat_delta / 100.0).clamp(0.0, 1.0);
        let new_l = (l + lum_delta / 100.0).clamp(0.0, 1.0);

        let (r, g, b) = hsl_to_rgb(new_h, new_s, new_l);
        px[0] = r;
        px[1] = g;
        px[2] = b;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_identity_params() {
        let params = HslParams {
            hue_shifts: [0.0; 8],
            sat_shifts: [0.0; 8],
            lum_shifts: [0.0; 8],
        };
        assert!(params.is_identity());

        let mut buf = [0.5, 0.3, 0.1, 1.0];
        apply_hsl_adjust(&mut buf, &params);
        // 身份参数不应改变像素（允许浮点误差）
        assert!((buf[0] - 0.5).abs() < 0.001);
        assert!((buf[1] - 0.3).abs() < 0.001);
        assert!((buf[2] - 0.1).abs() < 0.001);
    }

    #[test]
    fn test_hue_distance_wrapping() {
        assert!((hue_distance(350.0, 10.0) - 20.0).abs() < 0.001);
        assert!((hue_distance(10.0, 350.0) - 20.0).abs() < 0.001);
        assert!((hue_distance(180.0, 180.0)).abs() < 0.001);
    }

    #[test]
    fn test_saturation_shift() {
        let mut params = HslParams {
            hue_shifts: [0.0; 8],
            sat_shifts: [50.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            lum_shifts: [0.0; 8],
        };
        // 红色像素，中心 0°
        let mut buf = [1.0, 0.0, 0.0, 1.0];
        let (h, s, l) = rgb_to_hsl(buf[0], buf[1], buf[2]);
        apply_hsl_adjust(&mut buf, &params);
        let (h2, s2, l2) = rgb_to_hsl(buf[0], buf[1], buf[2]);
        // 饱和度应上升（红色已满饱和 1.0，clamp 到 1.0）
        assert!(s2 >= s);
    }

    #[test]
    fn test_hue_shift_blue_range() {
        // 蓝色像素 (~240°)，对 blue 中心 225° 应有高权重
        let params = HslParams {
            hue_shifts: [0.0, 0.0, 0.0, 0.0, 0.0, 30.0, 0.0, 0.0], // blue +30°
            sat_shifts: [0.0; 8],
            lum_shifts: [0.0; 8],
        };
        let mut buf = [0.0, 0.0, 1.0, 1.0];
        let (h_before, _, _) = rgb_to_hsl(buf[0], buf[1], buf[2]);
        apply_hsl_adjust(&mut buf, &params);
        let (h_after, _, _) = rgb_to_hsl(buf[0], buf[1], buf[2]);
        // 色相应偏移
        assert!((h_after - h_before).abs() > 1.0);
    }
}
```

注意：需要加 `use rayon::prelude::*;` 在文件顶部。

- [ ] **Step 2: 在 mod.rs 注册模块**

在 `src-tauri/src/processing/mod.rs` 添加：

```rust
pub mod hsl_adjust;
```

- [ ] **Step 3: 运行测试验证**

```bash
cd src-tauri && cargo test hsl_adjust -- --nocapture
```

Expected: 4 tests PASS

- [ ] **Step 4: 运行 clippy**

```bash
cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings
```

Expected: 无 warning

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/processing/hsl_adjust.rs src-tauri/src/processing/mod.rs
git commit -m "feat(processing): add HSL adjustment module with soft-boundary weighting"
```

---

### Task 2: Rust — FilterSettings 新增 24 字段 + 管线集成

**Files:**
- Modify: `src-tauri/src/processing/pipeline.rs`
- Modify: `src-tauri/src/processing/is_identity.rs`

- [ ] **Step 1: 在 pipeline.rs 的 FilterSettings struct 中新增 24 个字段**

在 `FilterSettings` struct 末尾（`vibrance` 和 `saturation` 之后）添加：

```rust
    // HSL adjustment
    pub hsl_red_hue: f32,
    pub hsl_red_sat: f32,
    pub hsl_red_lum: f32,
    pub hsl_orange_hue: f32,
    pub hsl_orange_sat: f32,
    pub hsl_orange_lum: f32,
    pub hsl_yellow_hue: f32,
    pub hsl_yellow_sat: f32,
    pub hsl_yellow_lum: f32,
    pub hsl_green_hue: f32,
    pub hsl_green_sat: f32,
    pub hsl_green_lum: f32,
    pub hsl_aqua_hue: f32,
    pub hsl_aqua_sat: f32,
    pub hsl_aqua_lum: f32,
    pub hsl_blue_hue: f32,
    pub hsl_blue_sat: f32,
    pub hsl_blue_lum: f32,
    pub hsl_purple_hue: f32,
    pub hsl_purple_sat: f32,
    pub hsl_purple_lum: f32,
    pub hsl_magenta_hue: f32,
    pub hsl_magenta_sat: f32,
    pub hsl_magenta_lum: f32,
```

同时在 `Default for FilterSettings` 中添加对应默认值 `0.0`。

- [ ] **Step 2: 在 pipeline.rs 的 process_image_cpu 中插入 HSL 调用**

在 step [7] vibrance+saturation 之后、step [9] 之前，添加：

```rust
    // [7b] HSL adjustment
    {
        let params = hsl_adjust::HslParams {
            hue_shifts: [
                settings.hsl_red_hue,
                settings.hsl_orange_hue,
                settings.hsl_yellow_hue,
                settings.hsl_green_hue,
                settings.hsl_aqua_hue,
                settings.hsl_blue_hue,
                settings.hsl_purple_hue,
                settings.hsl_magenta_hue,
            ],
            sat_shifts: [
                settings.hsl_red_sat,
                settings.hsl_orange_sat,
                settings.hsl_yellow_sat,
                settings.hsl_green_sat,
                settings.hsl_aqua_sat,
                settings.hsl_blue_sat,
                settings.hsl_purple_sat,
                settings.hsl_magenta_sat,
            ],
            lum_shifts: [
                settings.hsl_red_lum,
                settings.hsl_orange_lum,
                settings.hsl_yellow_lum,
                settings.hsl_green_lum,
                settings.hsl_aqua_lum,
                settings.hsl_blue_lum,
                settings.hsl_purple_lum,
                settings.hsl_magenta_lum,
            ],
        };
        if !params.is_identity() {
            hsl_adjust::apply_hsl_adjust(&mut buf, &params);
        }
    }
```

- [ ] **Step 3: 更新 is_identity.rs**

在 `is_identity` 函数中添加 24 个字段的判断：

```rust
    // HSL
    && s.hsl_red_hue == 0.0
    && s.hsl_red_sat == 0.0
    && s.hsl_red_lum == 0.0
    && s.hsl_orange_hue == 0.0
    && s.hsl_orange_sat == 0.0
    && s.hsl_orange_lum == 0.0
    && s.hsl_yellow_hue == 0.0
    && s.hsl_yellow_sat == 0.0
    && s.hsl_yellow_lum == 0.0
    && s.hsl_green_hue == 0.0
    && s.hsl_green_sat == 0.0
    && s.hsl_green_lum == 0.0
    && s.hsl_aqua_hue == 0.0
    && s.hsl_aqua_sat == 0.0
    && s.hsl_aqua_lum == 0.0
    && s.hsl_blue_hue == 0.0
    && s.hsl_blue_sat == 0.0
    && s.hsl_blue_lum == 0.0
    && s.hsl_purple_hue == 0.0
    && s.hsl_purple_sat == 0.0
    && s.hsl_purple_lum == 0.0
    && s.hsl_magenta_hue == 0.0
    && s.hsl_magenta_sat == 0.0
    && s.hsl_magenta_lum == 0.0
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo build && cargo clippy --all-targets --all-features -- -D warnings
```

Expected: 编译通过，无 warning

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/processing/pipeline.rs src-tauri/src/processing/is_identity.rs
git commit -m "feat(processing): add 24 HSL fields to FilterSettings and integrate into CPU pipeline"
```

---

### Task 3: Rust — GPU 路径集成

**Files:**
- Modify: `src-tauri/src/processing/gpu/uniforms.rs`
- Modify: `src-tauri/src/processing/gpu/passes/color_fused.rs`
- Modify: `src-tauri/src/processing/gpu/shaders/color_fused.wgsl`

- [ ] **Step 1: 在 FilterUniforms struct 新增 24 个字段**

在 `uniforms.rs` 的 `FilterUniforms` struct 中（`grain_` 字段之后）添加：

```rust
    // HSL adjustment
    pub hsl_red_hue: f32,
    pub hsl_red_sat: f32,
    pub hsl_red_lum: f32,
    pub hsl_orange_hue: f32,
    pub hsl_orange_sat: f32,
    pub hsl_orange_lum: f32,
    pub hsl_yellow_hue: f32,
    pub hsl_yellow_sat: f32,
    pub hsl_yellow_lum: f32,
    pub hsl_green_hue: f32,
    pub hsl_green_sat: f32,
    pub hsl_green_lum: f32,
    pub hsl_aqua_hue: f32,
    pub hsl_aqua_sat: f32,
    pub hsl_aqua_lum: f32,
    pub hsl_blue_hue: f32,
    pub hsl_blue_sat: f32,
    pub hsl_blue_lum: f32,
    pub hsl_purple_hue: f32,
    pub hsl_purple_sat: f32,
    pub hsl_purple_lum: f32,
    pub hsl_magenta_hue: f32,
    pub hsl_magenta_sat: f32,
    pub hsl_magenta_lum: f32,
```

- [ ] **Step 2: 在 color_fused.rs 的 uniforms 构建中填充 HSL 字段**

在 `color_fused.rs` 构建 `FilterUniforms` 的地方，对应添加赋值：

```rust
        // HSL
        hsl_red_hue: settings.hsl_red_hue,
        hsl_red_sat: settings.hsl_red_sat,
        hsl_red_lum: settings.hsl_red_lum,
        hsl_orange_hue: settings.hsl_orange_hue,
        hsl_orange_sat: settings.hsl_orange_sat,
        hsl_orange_lum: settings.hsl_orange_lum,
        hsl_yellow_hue: settings.hsl_yellow_hue,
        hsl_yellow_sat: settings.hsl_yellow_sat,
        hsl_yellow_lum: settings.hsl_yellow_lum,
        hsl_green_hue: settings.hsl_green_hue,
        hsl_green_sat: settings.hsl_green_sat,
        hsl_green_lum: settings.hsl_green_lum,
        hsl_aqua_hue: settings.hsl_aqua_hue,
        hsl_aqua_sat: settings.hsl_aqua_sat,
        hsl_aqua_lum: settings.hsl_aqua_lum,
        hsl_blue_hue: settings.hsl_blue_hue,
        hsl_blue_sat: settings.hsl_blue_sat,
        hsl_blue_lum: settings.hsl_blue_lum,
        hsl_purple_hue: settings.hsl_purple_hue,
        hsl_purple_sat: settings.hsl_purple_sat,
        hsl_purple_lum: settings.hsl_purple_lum,
        hsl_magenta_hue: settings.hsl_magenta_hue,
        hsl_magenta_sat: settings.hsl_magenta_sat,
        hsl_magenta_lum: settings.hsl_magenta_lum,
```

- [ ] **Step 3: 在 color_fused.wgsl 中添加 HSL 调节逻辑**

在 shader 中 vibrance+saturation 步骤之后添加 HSL 调节。需要添加：

a) uniforms 声明部分追加 24 个字段
b) rgb_to_hsl / hsl_to_rgb WGSL 函数
c) HSL 调节计算步骤

在 uniform struct 中添加（`grain_` 字段之后）：

```wgsl
    hsl_red_hue: f32,
    hsl_red_sat: f32,
    hsl_red_lum: f32,
    hsl_orange_hue: f32,
    hsl_orange_sat: f32,
    hsl_orange_lum: f32,
    hsl_yellow_hue: f32,
    hsl_yellow_sat: f32,
    hsl_yellow_lum: f32,
    hsl_green_hue: f32,
    hsl_green_sat: f32,
    hsl_green_lum: f32,
    hsl_aqua_hue: f32,
    hsl_aqua_sat: f32,
    hsl_aqua_lum: f32,
    hsl_blue_hue: f32,
    hsl_blue_sat: f32,
    hsl_blue_lum: f32,
    hsl_purple_hue: f32,
    hsl_purple_sat: f32,
    hsl_purple_lum: f32,
    hsl_magenta_hue: f32,
    hsl_magenta_sat: f32,
    hsl_magenta_lum: f32,
```

在 shader 函数区域添加 HSL 转换和调节函数：

```wgsl
fn wgsl_rgb_to_hsl(r: f32, g: f32, b: f32) -> vec3<f32> {
    let max_c = max(r, max(g, b));
    let min_c = min(r, min(g, b));
    let l = (max_c + min_c) * 0.5;
    var h: f32 = 0.0;
    var s: f32 = 0.0;
    if max_c != min_c {
        let d = max_c - min_c;
        s = select(d / (2.0 - max_c - min_c), d / (max_c + min_c), l < 0.5);
        if max_c == r {
            h = ((g - b) / d + select(6.0, 0.0, g >= b)) * 60.0;
        } else if max_c == g {
            h = ((b - r) / d + 2.0) * 60.0;
        } else {
            h = ((r - g) / d + 4.0) * 60.0;
        }
    }
    return vec3<f32>(h, s, l);
}

fn wgsl_hsl_to_rgb(h: f32, s: f32, l: f32) -> vec3<f32> {
    if s == 0.0 {
        return vec3<f32>(l, l, l);
    }
    let q = select(l * (1.0 + s), l + s - l * s, l < 0.5);
    let p = 2.0 * l - q;
    let hk = h / 360.0;
    var rgb = vec3<f32>(hk + 1.0/3.0, hk, hk - 1.0/3.0);
    rgb = fract(rgb);
    // helper: hue_to_rgb channel
    let r = hue_to_channel(rgb.x, p, q);
    let g = hue_to_channel(rgb.y, p, q);
    let b = hue_to_channel(rgb.z, p, q);
    return vec3<f32>(r, g, b);
}

fn hue_to_channel(t: f32, p: f32, q: f32) -> f32 {
    var tc = t;
    if tc < 1.0/6.0 {
        return p + (q - p) * 6.0 * tc;
    }
    if tc < 0.5 {
        return q;
    }
    if tc < 2.0/3.0 {
        return p + (q - p) * (2.0/3.0 - tc) * 6.0;
    }
    return p;
}

fn apply_hsl_adjust(r: f32, g: f32, b: f32, u: FilterUniforms) -> vec3<f32> {
    let hsl = wgsl_rgb_to_hsl(r, g, b);
    let h = hsl.x;
    let s = hsl.y;
    let l = hsl.z;

    let centers = array<f32, 8>(0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0);
    let hue_shifts = array<f32, 8>(
        u.hsl_red_hue, u.hsl_orange_hue, u.hsl_yellow_hue, u.hsl_green_hue,
        u.hsl_aqua_hue, u.hsl_blue_hue, u.hsl_purple_hue, u.hsl_magenta_hue
    );
    let sat_shifts = array<f32, 8>(
        u.hsl_red_sat, u.hsl_orange_sat, u.hsl_yellow_sat, u.hsl_green_sat,
        u.hsl_aqua_sat, u.hsl_blue_sat, u.hsl_purple_sat, u.hsl_magenta_sat
    );
    let lum_shifts = array<f32, 8>(
        u.hsl_red_lum, u.hsl_orange_lum, u.hsl_yellow_lum, u.hsl_green_lum,
        u.hsl_aqua_lum, u.hsl_blue_lum, u.hsl_purple_lum, u.hsl_magenta_lum
    );

    let sigma: f32 = 30.0;
    let inv_2sig_sq = 1.0 / (2.0 * sigma * sigma);

    var weights = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    var w_sum: f32 = 0.0;
    for (var i = 0u; i < 8u; i = i + 1u) {
        var dist = abs(h - centers[i]);
        if dist > 180.0 { dist = 360.0 - dist; }
        let w = exp(-dist * dist * inv_2sig_sq);
        weights[i] = w;
        w_sum = w_sum + w;
    }

    if w_sum <= 0.0 {
        return vec3<f32>(r, g, b);
    }

    let inv_sum = 1.0 / w_sum;
    var hue_delta: f32 = 0.0;
    var sat_delta: f32 = 0.0;
    var lum_delta: f32 = 0.0;
    for (var i = 0u; i < 8u; i = i + 1u) {
        let wn = weights[i] * inv_sum;
        hue_delta = hue_delta + hue_shifts[i] * wn;
        sat_delta = sat_delta + sat_shifts[i] * wn;
        lum_delta = lum_delta + lum_shifts[i] * wn;
    }

    var new_h = ((h + hue_delta) % 360.0 + 360.0) % 360.0;
    var new_s = clamp(s + sat_delta / 100.0, 0.0, 1.0);
    var new_l = clamp(l + lum_delta / 100.0, 0.0, 1.0);

    return wgsl_hsl_to_rgb(new_h, new_s, new_l);
}
```

在 main compute shader 的 vibrance+saturation 步骤之后调用：

```wgsl
    // HSL adjustment
    let hsl_result = apply_hsl_adjust(color.x, color.y, color.z, u);
    color = vec4<f32>(hsl_result.x, hsl_result.y, hsl_result.z, color.w);
```

- [ ] **Step 4: 编译验证 GPU 路径**

```bash
cd src-tauri && cargo build && cargo clippy --all-targets --all-features -- -D warnings
```

Expected: 编译通过，无 warning

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/processing/gpu/uniforms.rs src-tauri/src/processing/gpu/passes/color_fused.rs src-tauri/src/processing/gpu/shaders/color_fused.wgsl
git commit -m "feat(gpu): add HSL adjustment to GPU pipeline (uniforms + shader)"
```

---

### Task 4: 前端 — 类型与默认值

**Files:**
- Modify: `src/types.ts`
- Modify: `src/store/defaults.ts`

- [ ] **Step 1: 在 types.ts 的 FilterSettings interface 中新增 24 字段**

在 `FilterSettings` interface 末尾添加：

```typescript
  // HSL adjustment
  hslRedHue: number;
  hslRedSat: number;
  hslRedLum: number;
  hslOrangeHue: number;
  hslOrangeSat: number;
  hslOrangeLum: number;
  hslYellowHue: number;
  hslYellowSat: number;
  hslYellowLum: number;
  hslGreenHue: number;
  hslGreenSat: number;
  hslGreenLum: number;
  hslAquaHue: number;
  hslAquaSat: number;
  hslAquaLum: number;
  hslBlueHue: number;
  hslBlueSat: number;
  hslBlueLum: number;
  hslPurpleHue: number;
  hslPurpleSat: number;
  hslPurpleLum: number;
  hslMagentaHue: number;
  hslMagentaSat: number;
  hslMagentaLum: number;
```

- [ ] **Step 2: 在 defaults.ts 的 DEFAULT_FILTER 中新增 24 个默认值**

```typescript
  // HSL adjustment
  hslRedHue: 0,
  hslRedSat: 0,
  hslRedLum: 0,
  hslOrangeHue: 0,
  hslOrangeSat: 0,
  hslOrangeLum: 0,
  hslYellowHue: 0,
  hslYellowSat: 0,
  hslYellowLum: 0,
  hslGreenHue: 0,
  hslGreenSat: 0,
  hslGreenLum: 0,
  hslAquaHue: 0,
  hslAquaSat: 0,
  hslAquaLum: 0,
  hslBlueHue: 0,
  hslBlueSat: 0,
  hslBlueLum: 0,
  hslPurpleHue: 0,
  hslPurpleSat: 0,
  hslPurpleLum: 0,
  hslMagentaHue: 0,
  hslMagentaSat: 0,
  hslMagentaLum: 0,
```

- [ ] **Step 3: 检查前端 is_identity 逻辑**

确认 `PreviewPanel.tsx` 中的 `isIdentity` 函数逻辑（它从 Rust 端获取，不需要前端单独维护），但如果有前端侧的 identity 检查需同步更新。

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/store/defaults.ts
git commit -m "feat(frontend): add 24 HSL fields to FilterSettings type and defaults"
```

---

### Task 5: 前端 — HslPanel 组件

**Files:**
- Create: `src/components/HslPanel.tsx`

- [ ] **Step 1: 创建 HslPanel.tsx**

```tsx
import { Palette } from "lucide-react";
import { useFilterStore } from "@/store";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Section } from "@/components/ui/section";
import { SliderField } from "@/components/ui/form";

const HSL_RANGES = [
  { key: "red", color: "#ff0000", labelKey: "hsl.red" },
  { key: "orange", color: "#ff8800", labelKey: "hsl.orange" },
  { key: "yellow", color: "#ffff00", labelKey: "hsl.yellow" },
  { key: "green", color: "#00ff00", labelKey: "hsl.green" },
  { key: "aqua", color: "#00ffff", labelKey: "hsl.aqua" },
  { key: "blue", color: "#0000ff", labelKey: "hsl.blue" },
  { key: "purple", color: "#8800ff", labelKey: "hsl.purple" },
  { key: "magenta", color: "#ff00ff", labelKey: "hsl.magenta" },
] as const;

type HslMode = "hue" | "sat" | "lum";

function getSliderConfig(mode: HslMode) {
  switch (mode) {
    case "hue":
      return { min: -180, max: 180, suffix: "Hue" as const };
    case "sat":
      return { min: -100, max: 100, suffix: "Sat" as const };
    case "lum":
      return { min: -100, max: 100, suffix: "Lum" as const };
  }
}

export function HslPanel() {
  const filter = useFilterStore((s) => s.filter);
  const setFilter = useFilterStore((s) => s.setFilter);

  return (
    <div className="flex flex-col gap-4 px-3 py-4">
      <Tabs defaultValue="hue">
        <TabsList className="w-full">
          <TabsTrigger value="hue" className="flex-1">
            {chrome.i18n?.getMessage?.("hsl.hue") ?? "色相"}
          </TabsTrigger>
          <TabsTrigger value="sat" className="flex-1">
            {chrome.i18n?.getMessage?.("hsl.saturation") ?? "饱和度"}
          </TabsTrigger>
          <TabsTrigger value="lum" className="flex-1">
            {chrome.i18n?.getMessage?.("hsl.luminance") ?? "明度"}
          </TabsTrigger>
        </TabsList>

        {(["hue", "sat", "lum"] as HslMode[]).map((mode) => {
          const config = getSliderConfig(mode);
          return (
            <TabsContent key={mode} value={mode}>
              <Section>
                {HSL_RANGES.map((range) => {
                  const field = `hsl${range.key.charAt(0).toUpperCase() + range.key.slice(1)}${config.suffix}` as keyof typeof filter;
                  return (
                    <div key={range.key} className="flex items-center gap-2">
                      <span
                        className="inline-block h-3 w-3 rounded-full shrink-0"
                        style={{ backgroundColor: range.color }}
                      />
                      <SliderField
                        label={range.labelKey}
                        value={(filter[field] as number) ?? 0}
                        min={config.min}
                        max={config.max}
                        onChange={(v) => setFilter({ [field]: v })}
                      />
                    </div>
                  );
                })}
              </Section>
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
```

注意：实际实现中 `SliderField` 的 label 参数需要使用 i18n 的 t() 函数而非 chrome.i18n，需根据项目现有 i18n 方案调整。`field` 的计算方式需确保与 types.ts 中 camelCase 字段名一致。

- [ ] **Step 2: 验证组件无 TypeScript 错误**

```bash
cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add src/components/HslPanel.tsx
git commit -m "feat(ui): add HslPanel component with 3 sub-tabs and 8 color range sliders"
```

---

### Task 6: 前端 — 集成 HSL Tab 到 FilterPanel

**Files:**
- Modify: `src/components/FilterPanel.tsx`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh.ts`

- [ ] **Step 1: 在 FilterPanel.tsx 中新增 HSL tab**

在 tab 列表中（adjust 和 watermark 之间）添加 HSL tab 项：

- 导入 `HslPanel` 组件和 `Palette` 图标
- 在 tabs array 中添加 `{ key: "hsl", icon: Palette, label: "hsl.title" }`
- 在 tab content 区域添加对应的 `<HslPanel />` 渲染

- [ ] **Step 2: 在 en.ts 中添加翻译**

```typescript
  "hsl.title": "HSL",
  "hsl.hue": "Hue",
  "hsl.saturation": "Saturation",
  "hsl.luminance": "Luminance",
  "hsl.red": "Red",
  "hsl.orange": "Orange",
  "hsl.yellow": "Yellow",
  "hsl.green": "Green",
  "hsl.aqua": "Aqua",
  "hsl.blue": "Blue",
  "hsl.purple": "Purple",
  "hsl.magenta": "Magenta",
```

- [ ] **Step 3: 在 zh.ts 中添加翻译**

```typescript
  "hsl.title": "HSL",
  "hsl.hue": "色相",
  "hsl.saturation": "饱和度",
  "hsl.luminance": "明度",
  "hsl.red": "红",
  "hsl.orange": "橙",
  "hsl.yellow": "黄",
  "hsl.green": "绿",
  "hsl.aqua": "浅蓝",
  "hsl.blue": "蓝",
  "hsl.purple": "紫",
  "hsl.magenta": "品红",
```

- [ ] **Step 4: lint 检查**

```bash
pnpm lint
```

Expected: 无 lint 错误

- [ ] **Step 5: Commit**

```bash
git add src/components/FilterPanel.tsx src/i18n/en.ts src/i18n/zh.ts
git commit -m "feat(ui): integrate HSL tab into FilterPanel with i18n support"
```

---

### Task 7: 端到端验证

**Files:** 无新文件

- [ ] **Step 1: 启动开发服务**

```bash
cd /Users/ry2019/private/FujiSim && pnpm tauri dev
```

- [ ] **Step 2: 功能验证**

1. 打开应用，加载一张图片
2. 点击 HSL tab，确认 3 个子 tab 切换正常
3. 切换到"色相"子 tab，拖动蓝色范围滑块到 +60，观察图片中蓝色区域色相变化
4. 切换到"饱和度"子 tab，拖动绿色范围滑块到 +50，观察绿色区域饱和度增强
5. 切换到"明度"子 tab，拖动红色范围滑块到 -30，观察红色区域变暗
6. 双击任意滑块归零，确认图片恢复
7. 切换到其他 tab 再切回 HSL，确认滑块值保持

- [ ] **Step 3: 边界验证**

1. 所有 24 个滑块保持 0 时，图片应无变化（与原图一致）
2. 同时调节相邻色相范围（如橙+30° 和黄+30°），交界处应平滑过渡无色带
3. 色相滑块拉到极端值（±180°），不应出现异常颜色或溢出

- [ ] **Step 4: 运行 Rust 测试**

```bash
cd src-tauri && cargo test
```

Expected: 所有测试通过

- [ ] **Step 5: Final commit if any fixes needed**

如有修复，提交：

```bash
git add -A
git commit -m "fix: address HSL feature integration issues"
```

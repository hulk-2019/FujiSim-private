# 颗粒效果重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将"效果"重命名为"颗粒"，并将原来的 2 个下拉选择器替换为 4 个滑块（颗粒效果、颗粒大小、粗糙程度、颗粒色彩，范围 0-100）。

**Architecture:** 从 Rust 核心算法 → GPU shader → Rust 管线/状态 → TypeScript 类型/Store → React UI → i18n，自底向上逐层修改。每个 task 产出一个可编译/可运行的变更，频繁提交。

**Tech Stack:** Rust (wgpu compute shader, serde), TypeScript, React (Zustand), i18next

---

## File Structure

| File | Change | Responsibility |
|------|--------|---------------|
| `src-tauri/src/state.rs` | Modify | FilterSettings 结构体：替换 `grain_effect`+`grain_size` 为 4 个数值字段 |
| `src-tauri/src/processing/grain.rs` | Modify | CPU 算法：读取新字段，适配新参数 |
| `src-tauri/src/processing/gpu/shaders/grain.wgsl` | Modify | GPU shader：uniform 结构体增加新字段 |
| `src-tauri/src/processing/gpu/passes/grain.rs` | Modify | GPU pass：构造新 uniform |
| `src-tauri/src/processing/gpu/tests/grain_determinism_test.rs` | Modify | 测试适配新参数 |
| `src-tauri/src/processing/pipeline.rs` | Modify | pipeline：适配新字段 |
| `src-tauri/src/db/presets.rs` | Modify | 预设 DB schema：增加新列 |
| `src/types.ts` | Modify | TS 类型：替换枚举为数值字段 |
| `src/store/defaults.ts` | Modify | 默认值：替换为 4 个滑块默认值 |
| `src/store/slices/filter.ts` | Modify | Store slice：替换 actions 为新字段 |
| `src/components/FilterPanel.tsx` | Modify | UI：替换下拉为滑块组 |
| `src/i18n/en.ts` | Modify | 英文翻译 |
| `src/i18n/zh.ts` | Modify | 中文翻译 |

---

### Task 1: Rust — 更新 FilterSettings 结构体

**Files:**
- Modify: `src-tauri/src/state.rs:6-27`

- [ ] **Step 1: 修改 FilterSettings 结构体**

将 `grain_effect: GrainStrength` 和 `grain_size: GrainSize` 替换为 4 个 `f32` 字段。同时删除 `GrainStrength` 和 `GrainSize` 枚举定义。

在 `src-tauri/src/state.rs` 中：

删除枚举定义：
```rust
// 删除这些枚举
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum GrainStrength {
    #[default]
    Off,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum GrainSize {
    #[default]
    Fine,
    Medium,
    Coarse,
}
```

修改 FilterSettings 结构体，将：
```rust
pub grain_effect: GrainStrength,
pub grain_size: GrainSize,
```
替换为：
```rust
#[serde(default = "default_grain_amount")]
pub grain_amount: f32,
#[serde(default = "default_grain_size")]
pub grain_size: f32,
#[serde(default = "default_grain_roughness")]
pub grain_roughness: f32,
#[serde(default = "default_grain_color")]
pub grain_color: f32,
```

在文件顶部添加默认值函数：
```rust
fn default_grain_amount() -> f32 { 0.0 }
fn default_grain_size() -> f32 { 50.0 }
fn default_grain_roughness() -> f32 { 50.0 }
fn default_grain_color() -> f32 { 50.0 }
```

在 FilterSettings 的 `Default` impl 中设置：
```rust
grain_amount: 0.0,
grain_size: 50.0,
grain_roughness: 50.0,
grain_color: 50.0,
```

注意：`serde(rename_all = "camelCase")` 已在结构体上，所以序列化后前端会看到 `grainAmount`, `grainSize`, `grainRoughness`, `grainColor`。

- [ ] **Step 2: 运行 cargo check 验证编译错误**

Run: `cd src-tauri && cargo check 2>&1 | head -80`
Expected: 编译错误出现在所有引用 `GrainStrength`、`GrainSize`、`grain_effect` 的地方。记录这些文件，后续 tasks 会修复。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/state.rs
git commit -m "refactor(state): replace grain enums with 4 numeric fields in FilterSettings"
```

---

### Task 2: Rust — 更新 CPU grain 算法

**Files:**
- Modify: `src-tauri/src/processing/grain.rs`

- [ ] **Step 1: 修改 apply_grain 函数签名和算法**

当前 `apply_grain` 接收 `GrainStrength` 和 `GrainSize` 枚举。修改为接收 4 个 `f32` 参数，算法严格遵循设计文档。

将函数签名从：
```rust
pub fn apply_grain(
    img: &mut RgbImage,
    strength: GrainStrength,
    size: GrainSize,
)
```
改为：
```rust
pub fn apply_grain(
    img: &mut RgbImage,
    grain_amount: f32,
    grain_size: f32,
    grain_roughness: f32,
    grain_color: f32,
)
```

修改算法逻辑（严格遵循设计文档中的参数映射）：

```rust
use rand::Rng;

/// 参数映射（取值 0-100）：
/// - grain_amount → 振幅: amplitude = (amount / 100)² × 0.12
/// - grain_size → cell: cell_size = 1 + (size / 100) × 3  (1px ~ 4px)
/// - grain_roughness → 粗糙度: roughness_mix = roughness / 100
/// - grain_color → 通道独立性: color_independence = color / 100
pub fn apply_grain(
    img: &mut RgbImage,
    grain_amount: f32,
    grain_size: f32,
    grain_roughness: f32,
    grain_color: f32,
) {
    if grain_amount <= 0.0 {
        return;
    }

    // 参数映射
    let amount = (grain_amount / 100.0).clamp(0.0, 1.0);
    let size = (grain_size / 100.0).clamp(0.0, 1.0);
    let roughness = (grain_roughness / 100.0).clamp(0.0, 1.0);
    let color_mix = (grain_color / 100.0).clamp(0.0, 1.0);

    let amplitude = amount * amount * 0.12; // 二次映射，更细腻的低端控制
    let cell_size = 1.0 + size * 3.0; // 1px ~ 4px
    let roughness_mix = roughness;
    let color_independence = color_mix;

    let (width, height) = img.dimensions();
    let mut rng = rand::thread_rng();

    for y in 0..height {
        for x in 0..width {
            // cell 量化：大 size → 同一 cell 内共享噪声
            let cx = (x as f32 / cell_size).floor() as u32;
            let cy = (y as f32 / cell_size).floor() as u32;

            // 第一层噪声（基于 cell 坐标）
            let seed1 = cx.wrapping_mul(374761393).wrapping_add(cy.wrapping_mul(668265263));
            let noise1 = hash_to_f32(seed1) * 2.0 - 1.0;

            // 第二层细粒度噪声（基于像素坐标）
            let seed2 = x.wrapping_mul(127).wrapping_add(y.wrapping_mul(311));
            let noise2 = hash_to_f32(seed2) * 2.0 - 1.0;

            // 粗糙度混合两层
            let noise = noise1 * (1.0 - roughness_mix) + noise2 * roughness_mix;

            // 通道独立性
            let r_offset = noise * amplitude;
            let g_noise = hash_to_f32(seed2.wrapping_add(7919)) * 2.0 - 1.0;
            let b_noise = hash_to_f32(seed2.wrapping_add(104729)) * 2.0 - 1.0;
            let g_offset = (noise * (1.0 - color_independence) + g_noise * color_independence) * amplitude;
            let b_offset = (noise * (1.0 - color_independence) + b_noise * color_independence) * amplitude;

            let pixel = img.get_pixel_mut(x, y);
            pixel[0] = ((pixel[0] as f32 / 255.0 + r_offset).clamp(0.0, 1.0) * 255.0) as u8;
            pixel[1] = ((pixel[1] as f32 / 255.0 + g_offset).clamp(0.0, 1.0) * 255.0) as u8;
            pixel[2] = ((pixel[2] as f32 / 255.0 + b_offset).clamp(0.0, 1.0) * 255.0) as u8;
        }
    }
}

/// 简单哈希到 [0, 1) f32
fn hash_to_f32(hash: u32) -> f32 {
    // 使用乘法哈希混淆
    let h = hash.wrapping_mul(0x45d9f3b);
    let h = (h ^ (h >> 16)).wrapping_mul(0x45d9f3b);
    let h = h ^ (h >> 16);
    h as f32 / u32::MAX as f32
}
```

- [ ] **Step 2: 运行 cargo check 验证 grain.rs 编译**

Run: `cd src-tauri && cargo check 2>&1 | head -30`
Expected: grain.rs 自身编译通过，但调用方仍报错。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/processing/grain.rs
git commit -m "refactor(grain): update CPU algorithm to use 4 numeric parameters"
```

---

### Task 3: Rust — 更新 GPU shader 和 pass

**Files:**
- Modify: `src-tauri/src/processing/gpu/shaders/grain.wgsl`
- Modify: `src-tauri/src/processing/gpu/passes/grain.rs`

- [ ] **Step 1: 修改 grain.wgsl uniform 结构体和 shader 逻辑**

将 grain.wgsl 中的 `GrainParams` uniform 结构体从枚举索引改为 4 个 float，算法与 CPU 版本保持一致：

```wgsl
struct GrainParams {
    grain_amount: f32,
    grain_size: f32,
    grain_roughness: f32,
    grain_color: f32,
}

@group(0) @binding(0) var<uniform> params: GrainParams;
@group(0) @binding(1) var input_tex: texture_2d<f32>;
@group(0) @binding(2) var output_tex: texture_storage_2d<rgba8unorm, write>;

// 参数映射：
// - grain_amount(0-100) → amplitude = (amount/100)² × 0.12
// - grain_size(0-100)   → cell_size = 1 + (size/100) × 3   (1px ~ 4px)
// - grain_roughness(0-100) → roughness_mix = roughness/100
// - grain_color(0-100)  → color_independence = color/100

fn hash_to_f32(h: u32) -> f32 {
    var v = h * 0x45d9f3bu;
    v = (v ^ (v >> 16u)) * 0x45d9f3bu;
    v = v ^ (v >> 16u);
    return f32(v) / 4294967295.0;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) {
        return;
    }

    if (params.grain_amount <= 0.0) {
        let color = textureLoad(input_tex, vec2<i32>(gid.xy), 0);
        textureStore(output_tex, vec2<i32>(gid.xy), color);
        return;
    }

    let amount = clamp(params.grain_amount / 100.0, 0.0, 1.0);
    let size = clamp(params.grain_size / 100.0, 0.0, 1.0);
    let roughness_mix = clamp(params.grain_roughness / 100.0, 0.0, 1.0);
    let color_independence = clamp(params.grain_color / 100.0, 0.0, 1.0);

    let amplitude = amount * amount * 0.12;
    let cell_size = 1.0 + size * 3.0;

    // Cell 量化
    let cx = u32(floor(f32(gid.x) / cell_size));
    let cy = u32(floor(f32(gid.y) / cell_size));

    // 第一层噪声（基于 cell 坐标）
    let seed1 = cx * 374761393u + cy * 668265263u;
    let noise1 = hash_to_f32(seed1) * 2.0 - 1.0;

    // 第二层细粒度噪声（基于像素坐标）
    let seed2 = gid.x * 127u + gid.y * 311u;
    let noise2 = hash_to_f32(seed2) * 2.0 - 1.0;

    // 粗糙度混合两层
    let noise = noise1 * (1.0 - roughness_mix) + noise2 * roughness_mix;

    // 通道独立性
    let r_offset = noise * amplitude;
    let g_n = hash_to_f32(seed2 + 7919u) * 2.0 - 1.0;
    let b_n = hash_to_f32(seed2 + 104729u) * 2.0 - 1.0;
    let g_offset = (noise * (1.0 - color_independence) + g_n * color_independence) * amplitude;
    let b_offset = (noise * (1.0 - color_independence) + b_n * color_independence) * amplitude;

    let color = textureLoad(input_tex, vec2<i32>(gid.xy), 0);
    let r = clamp(color.r + r_offset, 0.0, 1.0);
    let g = clamp(color.g + g_offset, 0.0, 1.0);
    let b = clamp(color.b + b_offset, 0.0, 1.0);

    textureStore(output_tex, vec2<i32>(gid.xy), vec4<f32>(r, g, b, color.a));
}
```

- [ ] **Step 2: 修改 GPU pass 构造 uniform**

在 `src-tauri/src/processing/gpu/passes/grain.rs` 中，修改 `GrainPass::execute` 方法，将原来从 `FilterSettings` 读取枚举改为读取 4 个 `f32` 字段并构造 uniform buffer。

替换原来构造 uniform 的代码为：
```rust
// 4 个 f32 = 16 bytes，满足 wgpu uniform alignment
let params: [f32; 4] = [
    settings.grain_amount,
    settings.grain_size,
    settings.grain_roughness,
    settings.grain_color,
];
```

注意：`GrainParams` uniform 结构体现在有 4 个 f32（16 bytes），天然满足 wgpu 的 16-byte alignment 要求，不需要额外 padding。

如果原来 `GrainPass::execute` 接收的是具体参数而非整个 `FilterSettings`，则相应修改函数签名为接收 4 个 `f32`。

- [ ] **Step 3: 运行 cargo check**

Run: `cd src-tauri && cargo check 2>&1 | head -30`
Expected: grain pass 和 shader 相关编译通过。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/processing/gpu/shaders/grain.wgsl src-tauri/src/processing/gpu/passes/grain.rs
git commit -m "refactor(gpu-grain): update shader and pass for 4 numeric grain params"
```

---

### Task 4: Rust — 更新 grain 确定性测试

**Files:**
- Modify: `src-tauri/src/processing/gpu/tests/grain_determinism_test.rs`

- [ ] **Step 1: 修改测试以使用新参数**

将测试中构造 `FilterSettings` 的地方，从使用 `grain_effect: GrainStrength::Medium` 等枚举值改为使用新的数值字段：

```rust
grain_amount: 50.0,
grain_size: 50.0,
grain_roughness: 50.0,
grain_color: 50.0,
```

同时删除对 `GrainStrength` 和 `GrainSize` 的 import。

- [ ] **Step 2: 运行 cargo test 验证测试通过**

Run: `cd src-tauri && cargo test grain -- --nocapture 2>&1 | tail -20`
Expected: 测试 PASS

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/processing/gpu/tests/grain_determinism_test.rs
git commit -m "test(grain): update determinism test for numeric grain params"
```

---

### Task 5: Rust — 更新 pipeline 调用

**Files:**
- Modify: `src-tauri/src/processing/pipeline.rs`

- [ ] **Step 1: 修改 pipeline 中 grain 相关调用**

在 `pipeline.rs` 的 `process_image` 或类似函数中，找到调用 `apply_grain` 和 GPU grain pass 的地方，将参数从枚举改为新字段。

CPU 路径：
```rust
// 旧: apply_grain(&mut img, settings.grain_effect.clone(), settings.grain_size.clone());
// 新:
apply_grain(
    &mut img,
    settings.grain_amount,
    settings.grain_size,
    settings.grain_roughness,
    settings.grain_color,
);
```

GPU 路径确保传递 `settings.grain_amount` 等新字段。

- [ ] **Step 2: 运行 cargo check 验证全部 Rust 编译通过**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: 编译通过，无错误

- [ ] **Step 3: 运行 cargo clippy**

Run: `cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings 2>&1 | tail -20`
Expected: 无 warnings

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/processing/pipeline.rs
git commit -m "refactor(pipeline): update grain call sites for numeric params"
```

---

### Task 6: Rust — 更新预设数据库

**Files:**
- Modify: `src-tauri/src/db/presets.rs`

- [ ] **Step 1: 修改数据库 schema 和预设读写逻辑**

在 `presets.rs` 中的 SQL CREATE TABLE 语句，将：
```sql
grain_effect TEXT NOT NULL DEFAULT 'Off',
grain_size TEXT NOT NULL DEFAULT 'Fine',
```
替换为：
```sql
grain_amount REAL NOT NULL DEFAULT 0.0,
grain_size REAL NOT NULL DEFAULT 50.0,
grain_roughness REAL NOT NULL DEFAULT 50.0,
grain_color REAL NOT NULL DEFAULT 50.0,
```

在 INSERT/SELECT 语句中，将对应的枚举字符串列替换为 4 个 REAL 列。

在 Rust 代码中从行读取时，将：
```rust
// 旧: 从 TEXT 列读枚举字符串再 parse
// 新: 直接读 f32
let grain_amount: f32 = row.get("grain_amount")?;
let grain_size: f32 = row.get("grain_size")?;
let grain_roughness: f32 = row.get("grain_roughness")?;
let grain_color: f32 = row.get("grain_color")?;
```

在序列化到 FilterSettings 时使用这 4 个数值字段。

同时更新内置预设种子数据中的 grain 相关字段为数值。

- [ ] **Step 2: 运行 cargo check 验证编译**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/db/presets.rs
git commit -m "refactor(presets): update DB schema for numeric grain fields"
```

---

### Task 7: Rust — 全量验证

**Files:** 无新变更

- [ ] **Step 1: 运行 cargo test**

Run: `cd src-tauri && cargo test 2>&1 | tail -20`
Expected: 所有测试 PASS

- [ ] **Step 2: 运行 cargo clippy**

Run: `cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings 2>&1 | tail -20`
Expected: 无 warnings

- [ ] **Step 3: 如果有任何编译或测试错误，修复后提交**

Run: `cd src-tauri && cargo build 2>&1 | tail -10`
Expected: BUILD SUCCEEDED

---

### Task 8: TypeScript — 更新类型定义和 Store

**Files:**
- Modify: `src/types.ts`
- Modify: `src/store/defaults.ts`
- Modify: `src/store/slices/filter.ts`

- [ ] **Step 1: 修改 types.ts**

删除 `GrainStrength` 和 `GrainSize` 枚举。修改 `FilterSettings` 接口：

将：
```typescript
grainEffect: GrainStrength;
grainSize: GrainSize;
```
替换为：
```typescript
grainAmount: number;
grainSize: number;
grainRoughness: number;
grainColor: number;
```

同时删除 `GrainStrength` 和 `GrainSize` 枚举定义。

- [ ] **Step 2: 修改 store/defaults.ts**

将：
```typescript
grainEffect: 'off' as GrainStrength,  // 或类似写法
grainSize: 'fine' as GrainSize,
```
替换为：
```typescript
grainAmount: 0,
grainSize: 50,
grainRoughness: 50,
grainColor: 50,
```

- [ ] **Step 3: 修改 store/slices/filter.ts**

将所有 `setGrainEffect` / `setGrainSize` action 替换为：
```typescript
setGrainAmount: (value: number) => set({ grainAmount: value }),
setGrainSize: (value: number) => set({ grainSize: value }),
setGrainRoughness: (value: number) => set({ grainRoughness: value }),
setGrainColor: (value: number) => set({ grainColor: value }),
```

或者在 slice 的 set 函数中，如果使用的是通用 `setFilter` 模式，确保新字段名被正确处理。

- [ ] **Step 4: 运行 TypeScript 编译检查**

Run: `cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -40`
Expected: 前端编译错误出现在 FilterPanel.tsx 和 i18n 等引用旧字段的地方，这是预期的。

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/store/defaults.ts src/store/slices/filter.ts
git commit -m "refactor(ts): replace grain enums with numeric fields in types and store"
```

---

### Task 9: React — 更新 FilterPanel UI

**Files:**
- Modify: `src/components/FilterPanel.tsx`

- [ ] **Step 1: 将"效果"下拉替换为"颗粒"滑块组**

找到 FilterPanel 中渲染 grain 效果的部分。将原来的 2 个下拉选择器（GrainStrength、GrainSize）替换为一个可展开的"颗粒"分组，包含 4 个滑块。

在 FilterPanel 中，找到类似这样的 grain 渲染代码块，替换为：

```tsx
// 在 filterGroups 或类似的配置数组中
// 将原来的 grain 相关配置项替换为：

{
  key: 'grain',
  label: t('filters.grain'),
  expanded: false,
  filters: [
    {
      key: 'grainAmount',
      label: t('filters.grainAmount'),
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: 'grainSize',
      label: t('filters.grainAmount'),
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: 'grainRoughness',
      label: t('filters.grainRoughness'),
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: 'grainColor',
      label: t('filters.grainColor'),
      min: 0,
      max: 100,
      step: 1,
    },
  ],
},
```

注意：如果 FilterPanel 使用了特殊的下拉组件渲染 `GrainStrength`/`GrainSize`，需要将该渲染逻辑替换为通用滑块组件。确保 store 中使用 `setGrainAmount`/`setGrainSize`/`setGrainRoughness`/`setGrainColor` 来更新值。

- [ ] **Step 2: 验证前端编译通过**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: 编译通过，无 grain 相关错误

- [ ] **Step 3: Commit**

```bash
git add src/components/FilterPanel.tsx
git commit -m "feat(ui): replace grain dropdowns with 4 sliders in FilterPanel"
```

---

### Task 10: i18n — 更新翻译

**Files:**
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh.ts`

- [ ] **Step 1: 在 en.ts 中更新 grain 相关翻译**

删除 `filters.grainEffect` 和 `filters.grainSize` 的旧枚举翻译，添加：

```typescript
filters: {
  // ... 其他保持不变
  grain: 'Grain',
  grainAmount: 'Grain Amount',
  grainSize: 'Grain Size',
  grainRoughness: 'Roughness',
  grainColor: 'Grain Color',
  // 删除: grainEffect, grainStrength 相关
}
```

- [ ] **Step 2: 在 zh.ts 中更新 grain 相关翻译**

```typescript
filters: {
  // ... 其他保持不变
  grain: '颗粒',
  grainAmount: '颗粒效果',
  grainSize: '颗粒大小',
  grainRoughness: '粗糙程度',
  grainColor: '颗粒色彩',
  // 删除: grainEffect, grainStrength 相关
}
```

- [ ] **Step 3: 验证前端编译通过**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git add src/i18n/en.ts src/i18n/zh.ts
git commit -m "feat(i18n): update grain translations for new slider labels"
```

---

### Task 11: 全量验证

**Files:** 无新变更

- [ ] **Step 1: Rust 全量检查**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets --all-features -- -D warnings`
Expected: 全部 PASS，无 warnings

- [ ] **Step 2: 前端全量检查**

Run: `cd /Users/ry2019/private/FujiSim && pnpm lint && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 启动应用并手动验证**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tauri dev`

验证项：
1. 滤镜面板中"效果"已更名为"颗粒"
2. 展开后显示 4 个滑块：颗粒效果(0-100)、颗粒大小(0-100)、粗糙程度(0-100)、颗粒色彩(0-100)
3. 调整滑块后图片预览有对应的颗粒效果变化
4. 保存/加载预设正常工作

- [ ] **Step 4: 最终 Commit**

如果有任何修复：
```bash
git add -A
git commit -m "fix: final adjustments for grain refactor"
```

# WebGPU (wgpu + WGSL) 实时渲染管线设计

**日期**: 2026-05-25
**状态**: Design approved, pending implementation plan
**作者**: hong.rong + Claude

---

## 1. 背景与目标

### 1.1 现状

当前实时预览路径（[ipc/preview.rs:30](../../../src-tauri/src/ipc/preview.rs#L30)）：

```
前端 onChange (debounce 80ms)
  → IPC get_preview
  → tokio::spawn_blocking
    → RAW 解码（rsraw / vips_io）
    → 缩放（vips）
    → process_image (CPU rayon 流水线，14 步全像素遍历，[pipeline.rs:151](../../../src-tauri/src/processing/pipeline.rs#L151))
    → JPEG 编码 (vips)
    → 写入 system temp 文件
  → 前端 <img src="convertFileSrc(path)"> 重新加载
```

CPU 流水线在 1280px 预览上单帧 ~200–500ms，6000×4000 大图导出 ~1–2s/张，是用户体感卡顿与导出耗时的主要来源。

### 1.2 目标

用 **wgpu (Rust) + WGSL** 替换 [pipeline.rs](../../../src-tauri/src/processing/pipeline.rs) 中 14 步色彩流水线为 GPU compute 实现：

- 1280px 预览：单帧目标 < 30ms（含 upload + dispatch + readback + IPC）。
- 6000×4000 导出：单张目标 < 200ms（GPU 计算 + readback）。
- **预览与导出共用同一份 WGSL**，单一可信源。
- 颜色精度 RGBA16F 全程，与现有 16-bit 链路对齐。
- 函数签名零变更：[pipeline.rs:151](../../../src-tauri/src/processing/pipeline.rs#L151) `process_image` 内部实现替换，所有调用方（preview / export）零改动。

### 1.3 非目标

不在本次范围内（已登记到「未来工作」清单，§7）：

- Dehaze 算子的 GPU 化。
- RAW 解码（Bayer demosaic / WB / 色彩矩阵）的 GPU 化。
- 浏览器侧 WebGPU canvas 渲染（已评估并排除，理由见 §2）。
- 缩略图（cover）GPU 化。
- 实时直方图 / 波形 GPU 化。
- 跨进程 / 多 GPU 资源池统一。

---

## 2. 方案选型

评估了三个候选：

| 方案 | 链路 | 单帧 | 兼容性 | 导出复用 | 结论 |
|---|---|---|---|---|---|
| A. Rust + wgpu（后端 GPU） | IPC → Rust GPU → readback → JPEG | ~25ms | ★★★★★ Metal/DX12/Vulkan 自动 | 是 | **采用** |
| B. 浏览器 WebGPU + WGSL | 前端直接 dispatch → canvas | ~5ms | ⚠️ WebView2/WKWebView WebGPU 状态不稳 | 否 | 排除 |
| C. 混合（预览前端、导出后端） | 二选一各跑一套 | — | — | 否 | 排除 |

**方案 A 入选理由**：
- Tauri 桌面应用的最大优势是「我能控制整个二进制」，wgpu 在 Rust 侧能保证 macOS Metal / Windows DX12 / Linux Vulkan 一律可用，不被 WebView 的 WebGPU 支持拖累。
- 预览和导出共用一份 WGSL，单一可信源。
- 当前瓶颈是「CPU 流水线本身 200–500ms」，不是「IPC 5ms」，方案 A 已能把流水线压到 25ms 以内，方案 B 的 60fps 跟手优势在调色场景边际很小。

**CPU 降级路径**：不保留。GPU 唯一策略；wgpu 兼容范围（macOS 10.13+ / Windows 10+ / Linux Vulkan/GL）已覆盖项目目标用户群。CPU 算子函数仅作为单元测试中的数值参考保留。

---

## 3. 总体架构

### 3.1 边界

- **GPU 输入**：`ImageBuffer<Rgb<u16>, Vec<u16>>`（与现有 [pipeline.rs:152](../../../src-tauri/src/processing/pipeline.rs#L152) 入参一致）。
- **GPU 输出**：`ImageBuffer<Rgb<u16>, Vec<u16>>`（与现有出参一致）。
- **不变量**：RAW/JPEG/TIFF 解码仍走 CPU（[raw.rs](../../../src-tauri/src/processing/raw.rs) / [vips_io.rs](../../../src-tauri/src/vips_io.rs) 不动）；vips 缩放也保持不变。

### 3.2 模块结构

新增 `src-tauri/src/processing/gpu/`，每个文件 < 500 行：

```
src-tauri/src/processing/gpu/
├── mod.rs              # 对外 process_image_gpu(src, settings, lut) 入口
├── context.rs          # GpuContext：device/queue/pipeline 缓存、LUT 缓存
├── upload.rs           # ImageBuffer<u16> ↔ texture 转换（含 readback）
├── pipelines.rs        # 创建并缓存所有 compute pipeline 与 bind group layout
├── uniforms.rs         # FilterSettings → FilterUniforms 打包
├── curves_bake.rs      # CPU 端预 bake tone curve 到 1024 点 1D LUT
├── passes/
│   ├── mod.rs
│   ├── color_fused.rs  # 步骤 [1]–[10] fused
│   ├── lut3d.rs        # 步骤 [11]
│   ├── sharpen.rs      # 步骤 [13] clarity + sharpness（含 box blur H/V）
│   └── grain.rs        # 步骤 [14]
└── shaders/
    ├── color_fused.wgsl
    ├── lut3d.wgsl
    ├── box_blur_h.wgsl
    ├── box_blur_v.wgsl
    ├── sharpen.wgsl
    └── grain.wgsl
```

`process_image` 函数签名不变，函数体替换为：上传 src → `gpu::process_image_gpu` → readback → return。

### 3.3 GPU 上下文生命周期

`GpuContext` 由 [state.rs](../../../src-tauri/src/state.rs) 的 `SharedState` 在 Tauri `setup` 阶段一次性初始化，进程生命周期内长存：

```rust
pub struct GpuContext {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipelines: Pipelines,           // 全部 compute pipeline
    bind_group_layouts: Layouts,    // 配套 layout
    lut_cache: Mutex<HashMap<PathBuf, Arc<wgpu::Texture>>>, // 独立 GPU LUT 缓存
}
```

- **Adapter 选择**：`PowerPreference::HighPerformance`（独显优先）。
- **失败处理**：`GpuContext::new()` 失败直接 panic（GPU 唯一策略），日志写 tracing。
- **错误冒泡**：wgpu 异步错误经 `device.on_uncaptured_error` 转换为 `AppError` 抛回 IPC，前端按现有 `preview_busy` 风格 toast。

### 3.4 并发与 texture 池

- 现有 `preview_sem`（限 1）和 `export_pool`（限 2）保留，限制同时运行的 GPU 流水线数。
- **初版策略**：每次 `process_image_gpu` 按图像尺寸**临时分配** `midA` / `midB` 两张 rgba16f ping-pong texture，调用结束自动释放。
  - 6000×4000：384MB（每张 192MB），分配/释放 ~10ms。
  - 1280×853：~17MB，分配/释放 < 1ms。
- **后续优化**（不在本次范围）：size-bucketed texture pool。

---

## 4. GPU 管线 Pass 划分

GPU 上 **5 个 compute pass + 1 个 readback pass**，外加 1 个可选的 CPU 绕路（dehaze）。按整体执行顺序：

| # | Stage | 位置 | 输入 | 输出 | 备注 |
|---|---|---|---|---|---|
| 1 | color_fused | GPU | inputTex (rgba16f), curveLut (r16float, 1D), uniforms | midA (rgba16f) | 步骤 [1]–[10] |
| 2 | lut3d | GPU | midA, lutTex (rgba16f, 3D) | midB | 步骤 [11]，三线性插值；LUT 不存在时跳过（直接复用 midA 引用） |
| 3 | dehaze | **CPU 绕路**（一期） | midB readback → CPU `apply_dehaze` → 上传 | midA | 步骤 [12]，**初版仍走 CPU**；默认 dehaze=0 整段跳过，热路径零开销 |
| 4 | sharpen | GPU | midA → box_blur_h → tmpH → box_blur_v → tmpV → sharpen merge | midB | 步骤 [13]，三个 sub-dispatch（box_blur_h / box_blur_v / sharpen），半径在 CPU 端按 `res_scale` 计算后作 uniform |
| 5 | grain | GPU | midB | outTex (rgba16f) | 步骤 [14]，PCG hash，确定性 |
| 6 | pack16 | GPU readback | outTex | staging buffer | rgba16f → packed `Rgb<u16>` |

**Workgroup 尺寸**：点操作 / 邻域算子 16×16×1；readback pack 64×1×1。

**条件跳过策略**：fused shader 内部用 uniform 标志位条件分支跳过零值算子，**避免「拖一个滑块要重建 pipeline」**。LUT3D / sharpen / grain pass 在 CPU 端按 `settings` 决定是否 dispatch。

### 4.1 Uniform 布局

```rust
#[repr(C)]
struct FilterUniforms {
    // 步骤 [1] WB shift
    wb_shift: [f32; 2],         // r, b
    // 步骤 [2]–[4]
    exposure: f32,
    brightness: f32, contrast: f32,
    highlight: f32, shadow: f32, white: f32, black: f32,
    // 步骤 [5] preset 分通道倾斜（baked into curve LUT，仅保留 toggle）
    has_curve_lut: u32,
    // 步骤 [6] split toning + channel shift
    split_highlight: [f32; 3], split_shadow: [f32; 3],
    channel_shift: [f32; 3],
    // 步骤 [7] vibrance + saturation
    vibrance: f32, saturation: f32,
    // 步骤 [9] fade
    fade: f32,
    // 步骤 [10] monochrome
    monochrome: u32, mono_tint: [f32; 3],
    // 步骤 [13] sharpen
    clarity_amount: f32, clarity_radius: f32,
    sharpness_amount: f32, sharpness_radius: f32,
    // 步骤 [14] grain
    grain_strength: f32, grain_cell: f32, grain_seed: u32,
    // 输出尺寸
    width: u32, height: u32,
}
```

每帧一次上传（~80B），开销可忽略。

### 4.2 LUT 缓存

- **独立 GPU LUT 缓存**（不与 [state.rs](../../../src-tauri/src/state.rs) 的 CPU LUT cache 合并，避免本次 PR 范围扩大）。
- Key: `PathBuf`（与 CPU 缓存一致）。
- Value: `Arc<wgpu::Texture>`（rgba16f 3D，33×33×33，144KB / LUT）。
- 加载时机：`process_image_gpu` 接到 `lut_file_path` 后查 cache，未命中则解析 .cube → 上传 → 入 cache。
- 失效时机：与现有 CPU LUT 缓存联动（删除用户 LUT 时同步清理）。

---

## 5. WGSL 算子映射

### 5.1 决策摘要

| 步骤 | 类型 | 实现策略 |
|---|---|---|
| [1] WB shift | 点 | 直接翻译 |
| [2] exposure | 点 | 直接翻译（线性增益） |
| [3] brightness/contrast | 点 | 直接翻译 |
| [4] 4-segment tone | 点 | 直接翻译（参考 [tone.rs](../../../src-tauri/src/processing/tone.rs) `apply_tone_segments_pixel`） |
| [5] tone curve | 点 | **CPU 端 bake 4 条曲线为 1024 点 1D r16float texture，shader `textureSampleLevel` 采样** |
| [6] split toning + shift | 点 | 直接翻译 |
| [7] vibrance + saturation | 点 | 直接翻译（含 RGB↔HSL，参考 [color.rs](../../../src-tauri/src/processing/color.rs)） |
| [9] fade | 点 | 直接翻译 |
| [10] monochrome | 点 | 直接翻译（Rec.601 亮度） |
| [11] 3D LUT | 邻域采样 | rgba16f 3D texture + `textureSampleLevel` 三线性插值 |
| [12] dehaze | 多 pass | **CPU 后处理**（一期），仅在 `settings.dehaze != 0` 时 readback → CPU → 上传 |
| [13] clarity + sharpness | 邻域 | box blur H + V（workgroup shared 优化） + sharpen merge |
| [14] grain | 点 + hash | **确定性 PCG hash**，cell 内共享值；亮度掩膜（中灰最重）逻辑直接翻译 |

### 5.2 Tone curve bake

Fuji preset 的分通道倾斜（`profile.r_tilt` / `g_tilt` / `b_tilt`）与用户 4 条 curve point 在 CPU 端复合后，为每通道 bake 一张 1024 点 1D r16float LUT。Shader 端单次 `textureSampleLevel` 取值，精度 1024 远高于人眼可分辨色阶。

Bake 开销：4 × 1024 × float = 16KB / 帧，CPU 侧 ~50µs，相比 GPU dispatch 可忽略。

### 5.3 Grain 确定性

- WGSL 用 PCG hash：`hash21(vec2u(x/cell, y/cell) ^ seed_const)`，同 cell 内所有像素共享同一噪声。
- Seed 常量与 [pipeline.rs:347](../../../src-tauri/src/processing/pipeline.rs#L347) 保持 `0xC0FFEEu64`（截取低 32 位作 u32 seed）。
- **一致性定义**：不是与 CPU 逐字节相同（hash 函数不同必然差），而是：
  1. 同一图同一参数 GPU 多次跑结果完全一致（hash 输出哈希相等）；
  2. 与 CPU 参考 SSIM ≥ 0.98，颗粒方差差异 < 5%。

---

## 6. 测试与验证

### 6.1 单元测试（`src-tauri/src/processing/gpu/tests/`）

- 每个 pass 一个 `#[test]`，构造 16×16 小图 + 已知参数，GPU 跑一遍 → readback → 与 CPU 参考实现逐像素对比，**最大色差 < 1/65535**（16-bit 1 LSB 内）。
- color_fused：5 组典型参数（identity / 全开高光 / 全开阴影 / 单色 / Velvia preset）矩阵测试。
- box_blur：独立测试，对比 CPU `box_blur_lum`（[pipeline.rs:397](../../../src-tauri/src/processing/pipeline.rs#L397)）。

### 6.2 集成测试

- `tests/fixtures/` 5 张 256×256 测试图（纯灰渐变 / 高对比 / 低对比 / 饱和色块 / 噪声）。
- 每张图 × 8 个完整 FilterSettings 组合 → 跑 GPU 流水线 → 与 CPU 参考结果对比 **SSIM ≥ 0.99**。
- Grain 单独验证 **SSIM ≥ 0.98 + 颗粒方差差异 < 5%**。
- **确定性测试**：同一输入跑 100 次，输出哈希必须 100% 一致。

### 6.3 性能基准（`cargo bench`）

- 1280×853 预览：GPU 目标 < 30ms（含 upload + dispatch + readback），CPU 基线 ~200ms。
- 6000×4000 导出：GPU 目标 < 200ms，CPU 基线 ~1.5s。

### 6.4 CI

- macOS / Windows runner：原生 GPU 可用。
- Linux runner：依赖 `lavapipe` / `llvmpipe` 软渲染，性能慢但功能完整。
- GPU 不可用时 `cargo test` 跳过 GPU 测试并打印告警，本地开发机要求必须能跑。

### 6.5 手动验收清单（release 前）

5 张代表性 RAW × 13 个 Fuji preset，截图入 README/`docs/qa/`，发布前肉眼对照。**非 CI 强制**，作为 release checklist。

---

## 7. 迁移路径

### 7.1 里程碑

- **M1 — 基础设施**：引入 `wgpu = "23"` 依赖；新建 gpu 模块骨架；`GpuContext` 在 `SharedState::new` 中初始化；passthrough shader 打通端到端链路；测试输入 == 输出。
- **M2 — Color Fused Pass**：`color_fused.wgsl` 覆盖 [1]–[10]；CPU 1D LUT bake 工具；单测 + 集成测试达标。其余算子暂走 CPU 后处理。
- **M3 — LUT3D + Sharpen + Grain**：`lut3d.wgsl` + GPU LUT 缓存；`box_blur_h/v.wgsl` + `sharpen.wgsl`；`grain.wgsl`（确定性）。热路径全部 GPU。
- **M4 — 切换 + 收尾**：[pipeline.rs:151](../../../src-tauri/src/processing/pipeline.rs#L151) 内部改调 `gpu::process_image_gpu`；删除 CPU 流水线已被替换的算子函数（保留轻量副本到 `tests/cpu_reference.rs`）；性能 bench 入仓；README 更新最低系统要求。

### 7.2 风险登记

| 风险 | 概率 | 缓解 |
|---|---|---|
| Linux 用户无 Vulkan 驱动 | 低 | 文档明确最低要求；wgpu 自动尝试 GL backend |
| WGSL 编译错误在 release 才暴露 | 中 | 启动时 `device.create_shader_module` 必须全部成功，否则 panic |
| GPU 显存不足（4K+ 多张并发） | 低 | export_pool 已限并发 2，preview_sem 限 1 |
| readback 阻塞 tokio 调度 | 中 | `process_image_gpu` 仅在 `tokio::task::spawn_blocking` 中调用 |
| wgpu 版本升级 API 变更 | 中 | 锁定 23.x，独立分支升级 |
| Grain 与 CPU 视觉差异被用户察觉 | 低 | SSIM ≥ 0.98 把关；release 前手动验收清单 |

---

## 8. 未来工作（不在本次范围）

下列条目本次不实现，保留至后续迭代：

1. **Dehaze GPU 化**：拆为 dark channel / atmospheric light / guided filter A/B / recover 共 4–5 个 sub-pass。本次保留 CPU 后处理路径。
2. **RAW 解码 GPU 化**：Bayer demosaic / WB / 色彩矩阵迁移到 GPU，预期大 RAW 解码从 ~500ms 降至 ~50ms。难度极高（重写 LibRaw 子集），独立项目级工作。
3. **浏览器侧 WebGPU canvas 渲染**：用于追求 60fps 滑块跟手；需先解决 WebView2/WKWebView 的 WebGPU 支持稳定性。
4. **缩略图（cover）GPU 化**：当前走嵌入 JPEG 抽取，不进色彩流水线；如未来要在 cover 上应用滤镜则需此项。
5. **实时直方图 / 波形 GPU 化**：在 GPU 输出上挂一个 reduction pass。
6. **Size-bucketed texture pool**：减少大图反复分配/释放开销。
7. **CPU/GPU LUT 缓存统一**：合并 [state.rs](../../../src-tauri/src/state.rs) 的 CPU 缓存与本次的 GPU 缓存。
8. **HDR canvas 输出**：当浏览器侧 WebGPU 落地后才有意义。

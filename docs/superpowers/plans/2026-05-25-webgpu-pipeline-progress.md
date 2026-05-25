# WebGPU Pipeline 实施进度存档

**最后更新**：2026-05-25
**当前分支**：`feature/raw-3`
**最新提交**：`b3a62c8`
**关联文档**：
- Spec：[docs/superpowers/specs/2026-05-25-webgpu-pipeline-design.md](../specs/2026-05-25-webgpu-pipeline-design.md)
- Plan：[docs/superpowers/plans/2026-05-25-webgpu-pipeline.md](2026-05-25-webgpu-pipeline.md)

---

## 进度概览（15/16 任务完成）

| # | 任务 | 状态 | Commit |
|---|---|---|---|
| M1.1 | 添加 wgpu 依赖、创建 gpu 模块骨架 | ✅ 完成 | `9f3d6f5` |
| M1.2 | 把 GpuContext 接到 SharedState | ✅ 完成 | `d0e5321` |
| M1.3 | rgba16f upload + readback helpers | ✅ 完成 | `36d1997` + `da9aa7e` |
| M1.4 | passthrough compute pipeline 烟雾测试 | ✅ 完成 | `f777542` |
| M2.1 | tone curve bake 到 1024×4 LUT | ✅ 完成 | `5b936dd` |
| M2.2 | FilterUniforms 结构（std140） | ✅ 完成 | `6a7b3f7` + `b0247f8` |
| M2.3 | color_fused.wgsl 写步骤 [1]–[10] | ✅ 完成 | `5788d13` + `a154533` |
| M2.4 | color_fused host code + 缓存 pipeline | ✅ 完成 | `3d32942` |
| M2.5 | 数值回归测试 vs CPU pipeline | ✅ 完成 | `bd6b911` |
| M2.6 | process_image_gpu 入口（CPU tail 兜底） | ✅ 完成 | `e90de34` |
| M3.1 | GPU LUT 缓存 + lut3d.wgsl | ✅ 完成 | `8008bff` + `d6df95b` |
| M3.2 | box blur (H/V) + sharpen.wgsl | ✅ 完成 | `0b1b0bc` |
| M3.3 | sharpen pass host code | ✅ 完成 | `0aa2bee` |
| M3.4 | grain.wgsl + 确定性测试 | ✅ 完成 | `623024e` |
| **M3.5** | **全 GPU 流水线串通** | ✅ **完成** | `b3a62c8`（含 R16Float→Rgba16Float 修复） |
| M4.1 | 切换 process_image 走 GPU | 待办 | — |
| M4.2 | 验证 export 路径走 GPU | 待办 | — |
| M4.3 | criterion benchmark | 待办 | — |
| M4.4 | 文档更新（最低系统要求） | 待办 | — |
| M4.5 | 最终 lint/fmt/手动验证 | 待办 | — |

---

## 已落地的代码结构

```
src-tauri/src/processing/gpu/
├── mod.rs              # pub mod context / curves_bake / lut_cache / passes / passthrough / uniforms / upload
├── context.rs          # GpuContext { device, queue, pipelines: Pipelines }
├── curves_bake.rs      # bake(&FilterSettings) -> [Vec<f32>; 4]，row 3 已置 0（只用 row 0..2）
├── lut_cache.rs        # GpuLutCache: path → Arc<wgpu::Texture> 3D LUT 缓存
├── passthrough.rs      # M1.4 烟雾测试，M2 起未删除（仍用作 GPU 健康检查测试）
├── uniforms.rs         # FilterUniforms 144 字节 std140 布局
├── upload.rs           # upload_rgb16_as_rgba16f / readback_rgba16f_as_rgb16 + f16 helpers
├── passes/
│   ├── mod.rs          # pub mod color_fused / lut3d / sharpen
│   ├── color_fused.rs  # create_pipeline / dispatch / run_color_fused_only
│   ├── lut3d.rs        # create_pipeline / dispatch for 3D LUT trilinear sampling
│   └── sharpen.rs      # SharpenPipelines + create_pipelines + dispatch (box blur H/V + merge)
└── shaders/
    ├── box_blur_h.wgsl # 水平盒式模糊 → luma (Rec.709) → R16Float
    ├── box_blur_v.wgsl # 垂直盒式模糊 (R16Float → R16Float)
    ├── color_fused.wgsl
    ├── lut3d.wgsl
    ├── passthrough.wgsl
    └── sharpen.wgsl    # merge: clarity + sharpness 公式 (delta = dc + ds)
```

`SharedState` 现在携带 `pub gpu: Arc<GpuContext>`，在 `AppState::init` 中通过 `pollster::block_on(GpuContext::new())` 初始化。

---

## 已知/已修复问题（避免再踩坑）

1. **f16 subnormal 解码 bug**（M1.3）：原始 `f16_bits_to_f32` subnormal 路径 `e` 初始值写成 `-1`，正确应为 `1`，导致 u16 值 1–3（subnormal f16）解码偏小 4×。已在 `da9aa7e` 修复并加 `roundtrip_handles_subnormal_f16_values` 测试。

2. **std140 vec4 对齐 bug**（M2.2）：`FilterUniforms` 原本 136 字节，`split_hi_r` 在 offset 40，但 WGSL 的 vec4<f32> 需要 16 字节对齐 → naga 自动插 8 字节 padding，Rust 端没插就错位。已在 `b0247f8` 加 `_pad_after_has_master_curve: [u32; 2]`，结构体扩到 144 字节。测试里加了 `offset_of` 断言（用 1.75-MSRV 兼容的指针算术写法）。

3. **WGSL ↔ CPU 数学三处不匹配**（M2.3）：原始 spec 模板写得草率，实施时对照 CPU 代码后修正了：
   - **WB shift** 是乘法 `r * (1 + shift * 0.02)`，不是加法（且只动 R/B 通道）
   - **Brightness** 系数 `0.005`（即 `/200`），不是 `0.01`
   - **Tone segments** 用的是 Hermite cubic falloff + 阈值（hi>0.7 / white>0.85 / shadow<0.3 / black<0.15）+ 乘法保色调 `(l+δ)/l`，不是简单线性 mask
   - **Vibrance 权重** `(1-s)²`，不是 `(1-s)`
   - **Saturation** 加法 `s + amount/100`，不是乘法
   - **Split toning luminance** CPU 用 Rec.709 (`color::luminance`)，WGSL 修正前误用 Rec.601
   - **User curve 合成顺序**：CPU 是 `Fuji_per_ch → user_rgb → user_per_ch`；GPU 改为把 user_rgb baked 到 row 0..2 里，row 3 闲置（zeros），WGSL 不再 sample row 3
   - **Pre-vibrance clamp**：CPU 没有，WGSL 移除了

   后两条由 Opus reviewer 抓出来，实施者最初没察觉。修复在 `a154533`。

4. **拼写/可见性细节**：
   - `pollster::block_on(GpuContext::new())` 是关键的 `.await` 入口
   - `upload::f32_to_f16_bits` 后来从私有改为 `pub(super)`，让 sibling pass 模块（`passes/color_fused.rs`）能复用
   - clippy 偏爱 `u32::div_ceil` 而非 `(w + 15) / 16`，scope 中的代码已统一

---

## 下次启动应做的第一件事：M4.1 切换 process_image 走 GPU

### 任务全文

**Task M4.1: Switch process_image through GPU**

完整任务文本在 [plan 文档](2026-05-25-webgpu-pipeline.md) 的 Task M4.1 section。

### M4.1 关键提示

- 在 `process_image` 入口处优先调用 `process_image_gpu`
- GPU 不可用时 fallback 到 CPU 路径
- 保持 API 签名不变

---

## 工作流程提醒

我们用的是 superpowers:subagent-driven-development，每个任务三步走：

1. **Implementer**（sonnet）：按 task 文本严格实现，写测试、跑 build/clippy/fmt、commit。
2. **Spec reviewer**（sonnet）：独立读代码，逐条核对是否完整匹配 spec、有无 scope creep。
3. **Code quality reviewer**（sonnet 或 opus，看复杂度）：看 strengths / Critical / Important / Minor，决定 Approved 或 Changes requested。

复杂数学翻译任务（如 M2.3）建议 reviewer 用 **opus**，sonnet 抓不到 luma 权重 / 函数合成顺序这种细节。

每次三方流程跑完 → 在 plan 文件夹和这个 progress 文件里更新 commit SHA → 推进下一个任务。

---

## 重启后的第一条 prompt 建议

> 我之前在做 FujiSim 的 WebGPU 流水线改造（spec/plan 在 docs/superpowers），M3.5 已完成（commit b3a62c8），下一个是 M4.1 切换 process_image 走 GPU。请读 docs/superpowers/plans/2026-05-25-webgpu-pipeline-progress.md 了解进度，然后按 subagent-driven-development 流程继续推进 M4.1。

这样新会话能秒接上下文。

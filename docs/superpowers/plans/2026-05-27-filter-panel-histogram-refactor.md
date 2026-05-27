# FilterPanel 直方图重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"调整 Tab → 直方图"链路从单一 IPC 通道拆成预览 + 直方图双通道，修复两个 isIdentity bug，加入 luma 通道与裁剪警告，最后把 671 行的 FilterPanel.tsx 拆到 8 个文件。

**Architecture:** 后端新增独立 `compute_histogram` 命令（512px 工作图、独立 token、只算直方图不写盘），`get_preview` 移除 histogram 字段。前端用 `useHistogramSync` hook 走 80ms throttle 拉直方图，与 250ms debounce 的 preview 解耦。Histogram.tsx 增加 luma 通道与裁剪警告。FilterPanel.tsx 按 Section 拆到 `src/components/FilterPanel/`。

**Tech Stack:** Rust (Tauri 2.x, serde, tokio, image, rayon), TypeScript (React, zustand, Tauri JS API), Vitest/Cargo test, react-i18next

---

## 阶段 a：后端 IPC 解耦 + 修 Bug

### Task A1: 后端 — 在 SharedState 增加 histogram_token

**Files:**
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: 修改 AppState 结构体定义**

在 `src-tauri/src/state.rs:40` 行后（`pub preview_sem: Arc<Semaphore>` 之后）插入：

```rust
    /// 当前直方图请求的 token（单调递增）。与 preview_token 平行，
    /// compute_histogram 在解码完成后检查是否仍是最新值，
    /// 不是则返回 preview_cancelled，前端静默丢弃。
    /// 不复用 preview_token 是因为两条通道共用 token 会互相误杀。
    pub histogram_token: Arc<AtomicU64>,
```

- [ ] **Step 2: 修改 init() 中的字段初始化**

在 `src-tauri/src/state.rs` 的 `AppState::init()` 内 `preview_sem: Arc::new(Semaphore::new(1)),` 行之后加：

```rust
            preview_token: Arc::new(AtomicU64::new(0)),
            preview_sem: Arc::new(Semaphore::new(1)),
            histogram_token: Arc::new(AtomicU64::new(0)),
```

（注意：保留原有 `preview_token` / `preview_sem` 行，仅在 `preview_sem` 之后追加新行。）

- [ ] **Step 3: 编译验证**

Run: `cd /Users/ry2019/private/FujiSim/src-tauri && cargo check`
Expected: 通过，无 warning 关于 `histogram_token`。

- [ ] **Step 4: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src-tauri/src/state.rs
git commit -m "feat(state): add histogram_token for independent histogram cancellation"
```

---

### Task A2: 后端 — 新建 ipc/histogram.rs 模块

**Files:**
- Create: `src-tauri/src/ipc/histogram.rs`
- Modify: `src-tauri/src/ipc/mod.rs`

- [ ] **Step 1: 创建新文件**

写入 `src-tauri/src/ipc/histogram.rs`：

```rust
//! 独立直方图计算命令。与 get_preview 解耦：
//! - 工作尺寸 512px（256-bin 直方图视觉无差，CPU 砍 14×）
//! - 独立 histogram_token 取消，不与预览互相误杀
//! - 共享 preview_sem 信号量，避免抢 CPU
//! - 不写盘、不编 JPEG，纯计算后立即返回

use crate::db::assets;
use crate::error::{AppError, Result};
use crate::processing::histogram::{self, HistogramData};
use crate::processing::{self, FilterSettings};
use crate::state::SharedState;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn compute_histogram(
    state: State<'_, SharedState>,
    asset_id: i64,
    settings: Option<FilterSettings>,
    token: u64,
) -> Result<HistogramData> {
    use std::sync::atomic::Ordering;

    state.histogram_token.store(token, Ordering::SeqCst);

    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);
    let settings = settings.unwrap_or_default();
    let lut = super::cached_lut(&state, settings.lut_file_path.as_deref())?;
    let export_pool = state.export_pool.clone();
    let sem = state.preview_sem.clone();
    let histogram_token = state.histogram_token.clone();
    let raw_original_dir = state.raw_original_dir.clone();

    let permit = sem
        .acquire_owned()
        .await
        .map_err(|_| AppError::other("preview_busy"))?;

    if histogram_token.load(Ordering::SeqCst) != token {
        return Err(AppError::other("preview_cancelled"));
    }

    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        export_pool.install(|| {
            let cache_path = processing::raw::preview_base_path(&raw_original_dir, asset_id);

            let resized = if cache_path.exists() {
                match crate::vips_io::decode_to_rgb16(&cache_path) {
                    Ok(img) => img,
                    Err(_) => decode_and_resize_512(&path)?,
                }
            } else {
                decode_and_resize_512(&path)?
            };

            if histogram_token.load(Ordering::SeqCst) != token {
                return Err(AppError::other("preview_cancelled"));
            }

            let processed = crate::processing::process_image(&resized, &settings, lut.as_deref())?;
            Ok(histogram::compute(&processed))
        })
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}

fn decode_and_resize_512(
    path: &std::path::Path,
) -> Result<image::ImageBuffer<image::Rgb<u16>, Vec<u16>>> {
    use crate::asset::format::{classify, FileKind};
    let src = match classify(path) {
        FileKind::Raw => processing::raw::decode_raw_rgb16_for_preview(path, Some(512))?,
        _ => processing::load_image_rgb16(path)?,
    };
    let (w, h) = src.dimensions();
    let scale = (512.0_f32 / w.max(h) as f32).min(1.0);
    if scale < 1.0 {
        let nw = (w as f32 * scale).round().max(1.0) as u32;
        let nh = (h as f32 * scale).round().max(1.0) as u32;
        crate::vips_io::resize_rgb16(&src, nw, nh)
    } else {
        Ok(src)
    }
}
```

- [ ] **Step 2: 在 ipc/mod.rs 注册子模块**

修改 `src-tauri/src/ipc/mod.rs`，在 `pub mod export;` 之后插入 `pub mod histogram;`，并在 `pub use export::*;` 之后插入 `pub use histogram::*;`。最终该区域应像：

```rust
pub mod albums;
pub mod app;
pub mod assets;
pub mod export;
pub mod fonts;
pub mod histogram;
pub mod luts;
pub mod presets;
pub mod preview;
pub mod settings;
pub mod watermark;

pub use albums::*;
pub use app::*;
pub use assets::*;
pub use export::*;
pub use fonts::*;
pub use histogram::*;
pub use luts::*;
pub use presets::*;
pub use preview::*;
pub use settings::*;
pub use watermark::*;
```

- [ ] **Step 3: 在 lib.rs 注册命令**

修改 `src-tauri/src/lib.rs`，在 `ipc::eyedrop_color,` 行（约第 110 行）之后插入：

```rust
            ipc::compute_histogram,
```

- [ ] **Step 4: 编译验证**

Run: `cd /Users/ry2019/private/FujiSim/src-tauri && cargo check`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src-tauri/src/ipc/histogram.rs src-tauri/src/ipc/mod.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): add compute_histogram command (512px, independent token)"
```

---

### Task A3: 后端 — 从 PreviewResult 移除 histogram 字段

**Files:**
- Modify: `src-tauri/src/ipc/preview.rs`

- [ ] **Step 1: 修改 PreviewResult 结构体**

把 `src-tauri/src/ipc/preview.rs:13-19` 改为：

```rust
/// 预览结果。前端用 convertFileSrc(path) 加载本地文件，零 IPC 传输开销。
#[derive(Debug, Serialize, Clone)]
pub struct PreviewResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
}
```

（删掉 `pub histogram: histogram::HistogramData,`）

- [ ] **Step 2: 删除 get_preview 内部的直方图计算**

把 `src-tauri/src/ipc/preview.rs:97-111` 段中的：

```rust
            let (rw, rh) = resized.dimensions();
            let processed = crate::processing::process_image(&resized, &settings, lut.as_deref())?;
            let hist = histogram::compute(&processed);
            let jpeg =
                crate::vips_io::encode_rgb16(&processed, crate::export::ExportFormat::Jpeg, 88)?;
            let out_path =
                std::env::temp_dir().join(format!("fujisim_preview_{asset_id}_{token}.jpg"));
            std::fs::write(&out_path, &jpeg)
                .map_err(|e| AppError::other(format!("preview write: {e}")))?;
            Ok(PreviewResult {
                path: out_path.to_string_lossy().to_string(),
                width: rw,
                height: rh,
                histogram: hist,
            })
```

改为：

```rust
            let (rw, rh) = resized.dimensions();
            let processed = crate::processing::process_image(&resized, &settings, lut.as_deref())?;
            let jpeg =
                crate::vips_io::encode_rgb16(&processed, crate::export::ExportFormat::Jpeg, 88)?;
            let out_path =
                std::env::temp_dir().join(format!("fujisim_preview_{asset_id}_{token}.jpg"));
            std::fs::write(&out_path, &jpeg)
                .map_err(|e| AppError::other(format!("preview write: {e}")))?;
            Ok(PreviewResult {
                path: out_path.to_string_lossy().to_string(),
                width: rw,
                height: rh,
            })
```

- [ ] **Step 3: 删除不再使用的 import**

把 `src-tauri/src/ipc/preview.rs:5` 行：

```rust
use crate::processing::histogram;
```

删除（如果文件其他位置也未使用 histogram）。

- [ ] **Step 4: 编译验证**

Run: `cd /Users/ry2019/private/FujiSim/src-tauri && cargo check`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src-tauri/src/ipc/preview.rs
git commit -m "refactor(preview): drop histogram field from PreviewResult"
```

---

### Task A4: 前端 — 抽出 isIdentityFilter 工具函数（修 Bug #2）

**Files:**
- Create: `src/lib/filterIdentity.ts`

- [ ] **Step 1: 创建工具函数**

写入 `src/lib/filterIdentity.ts`：

```ts
import type { FilterSettings } from "@/types";
import { PASS_THROUGH_SIM } from "@/types";

/**
 * 判断 filter 是否为「无任何效果」状态。
 * 用于决定 RAW 在 identity 时是否跳过预览渲染（避免 RAW 解码空跑）。
 *
 * 历史上 PreviewPanel 内联了两份此判断，第二份漏掉 wb_shift_g，
 * 导致只动 tint 的边界场景判定不一致。统一到这里。
 */
export function isIdentityFilter(filter: FilterSettings): boolean {
  return (
    (filter.base_simulation === PASS_THROUGH_SIM || !filter.base_simulation) &&
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
    filter.wb_shift_g === 0 &&
    filter.wb_shift_b === 0 &&
    filter.grain_amount === 0 &&
    filter.hsl_red_hue === 0 &&
    filter.hsl_red_sat === 0 &&
    filter.hsl_red_lum === 0 &&
    filter.hsl_orange_hue === 0 &&
    filter.hsl_orange_sat === 0 &&
    filter.hsl_orange_lum === 0 &&
    filter.hsl_yellow_hue === 0 &&
    filter.hsl_yellow_sat === 0 &&
    filter.hsl_yellow_lum === 0 &&
    filter.hsl_green_hue === 0 &&
    filter.hsl_green_sat === 0 &&
    filter.hsl_green_lum === 0 &&
    filter.hsl_aqua_hue === 0 &&
    filter.hsl_aqua_sat === 0 &&
    filter.hsl_aqua_lum === 0 &&
    filter.hsl_blue_hue === 0 &&
    filter.hsl_blue_sat === 0 &&
    filter.hsl_blue_lum === 0 &&
    filter.hsl_purple_hue === 0 &&
    filter.hsl_purple_sat === 0 &&
    filter.hsl_purple_lum === 0 &&
    filter.hsl_magenta_hue === 0 &&
    filter.hsl_magenta_sat === 0 &&
    filter.hsl_magenta_lum === 0 &&
    (!filter.tone_curve ||
      (filter.tone_curve.rgb.length === 0 &&
        filter.tone_curve.r.length === 0 &&
        filter.tone_curve.g.length === 0 &&
        filter.tone_curve.b.length === 0))
  );
}
```

- [ ] **Step 2: TypeScript 检查**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src/lib/filterIdentity.ts
git commit -m "feat(lib): extract isIdentityFilter helper, fix wb_shift_g omission"
```

---

### Task A5: 前端 — 修改 PreviewResult 类型 + api.ts 增加 computeHistogram

**Files:**
- Modify: `src/types.ts:191-197`
- Modify: `src/api.ts`

- [ ] **Step 1: 修改 PreviewResult 类型**

把 `src/types.ts:191-197` 改为：

```ts
/** 预览渲染结果。`path` 是本地文件路径，前端用 convertFileSrc(path) 加载 */
export type PreviewResult = {
  path: string;
  width: number;
  height: number;
};
```

（删除 `histogram: HistogramData;` 字段）

- [ ] **Step 2: 在 api.ts 添加 computeHistogram**

在 `src/api.ts` 的 `getRawOriginal:` 那一行之后插入：

```ts
  /** 独立直方图计算（512px 工作图、独立 token）。与 getPreview 平行调用 */
  computeHistogram: (assetId: number, settings: FilterSettings | null, token: number) =>
    invoke<HistogramData>("compute_histogram", {
      assetId,
      settings,
      token,
    }),
```

并确保顶部的 import 包含 `HistogramData`（如果尚未导入则加上）：

```ts
import type {
  // ... 既有
  HistogramData,
  // ...
} from "./types";
```

- [ ] **Step 3: TypeScript 检查**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit`
Expected: 报错指向 `PreviewPanel.tsx` 中 `r.histogram` 引用不存在 — 这是 A6 要修的，**继续下一步暂不修**。

- [ ] **Step 4: Commit（暂时跳过 lint 全绿，等 A6 一起 commit）**

不 commit，留到 A6 一并提交。

---

### Task A6: 前端 — 新建 useHistogramSync hook + 重构 PreviewPanel

**Files:**
- Create: `src/hooks/useHistogramSync.ts`
- Modify: `src/components/PreviewPanel.tsx`

- [ ] **Step 1: 创建 hook**

写入 `src/hooks/useHistogramSync.ts`：

```ts
import { useEffect, useRef } from "react";
import { api } from "@/api";
import { useStore } from "@/store";
import type { FilterSettings } from "@/types";

/**
 * 持续把当前 (focusedId, filter) 的直方图同步到 store。
 *
 * 与 PreviewPanel 的预览拉取解耦：
 * - 80ms trailing-edge throttle（直方图计算轻量，可比预览更激进）
 * - 独立 token，不与预览 token 互相误杀
 * - identity + RAW 也照常请求（修复历史 bug：之前会让直方图永远是 null）
 */
let histogramTokenCounter = 0;

export function useHistogramSync(
  focusedId: number | null,
  filter: FilterSettings,
): void {
  const setHistogram = useStore((s) => s.setHistogram);
  const currentTokenRef = useRef(0);
  const pendingHandle = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!focusedId) {
      setHistogram(null);
      return;
    }

    if (pendingHandle.current) {
      clearTimeout(pendingHandle.current);
    }

    pendingHandle.current = setTimeout(async () => {
      const token = ++histogramTokenCounter;
      currentTokenRef.current = token;

      try {
        const data = await api.computeHistogram(focusedId, filter, token);
        if (currentTokenRef.current !== token) return;
        setHistogram(data);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("preview_cancelled") || msg.includes("preview_busy")) return;
        console.warn("[useHistogramSync] failed:", msg);
      }
    }, 80);

    return () => {
      if (pendingHandle.current) {
        clearTimeout(pendingHandle.current);
        pendingHandle.current = null;
      }
    };
  }, [focusedId, filter, setHistogram]);
}
```

- [ ] **Step 2: 修改 PreviewPanel — 删除直方图相关 + 改用 isIdentityFilter**

打开 `src/components/PreviewPanel.tsx`：

a. 在 import 区域（约第 1-10 行）追加：

```ts
import { isIdentityFilter } from "@/lib/filterIdentity";
import { useHistogramSync } from "@/hooks/useHistogramSync";
```

b. 删除 `setHistogram` 订阅（约第 45 行）：删除 `const setHistogram = useStore((s) => s.setHistogram);`

c. 在 `const focused = assets.find(...)` 之后插入：

```ts
  useHistogramSync(focusedId, filter);
```

d. 在第一个 useEffect (`focused?.id, filter` 依赖的) 中：
- 删除 `setHistogram(null);`（处理 `if (!focused)` 分支内）
- 把第一份内联 isIdentity 检测（约 161-209 行）替换为：

```ts
    const isIdentity = isIdentityFilter(filter);
```

- 把第二份内联 isIdentity 检测（约 217-265 行）整段替换为：

```ts
      const isIdentity = isIdentityFilter(filter);
```

- 删除 `setHistogram(r.histogram);` 这一行（在 `doPreview` 内部，约第 280 行）

e. 验证：搜索 PreviewPanel.tsx 中应不再出现 `setHistogram` 和 `r.histogram` / `.histogram`。

- [ ] **Step 3: TypeScript + Lint 检查**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit && pnpm lint`
Expected: 通过。

- [ ] **Step 4: 启动 dev 验证**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tauri dev`
手动验证：
1. 选一张普通图（非 RAW），拖动曝光滑块 — 直方图应平滑刷新
2. 选一张 RAW，不动任何滑块 — 直方图应正常显示（修 Bug #3）
3. 拖滑块时观察：直方图应明显比预览图先刷新
4. 按 Ctrl+C 停止

- [ ] **Step 5: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src/types.ts src/api.ts src/hooks/useHistogramSync.ts src/components/PreviewPanel.tsx
git commit -m "feat(histogram): decouple from preview, use 80ms throttle, fix identity bugs"
```

---

## 阶段 b：后端瘦身

### Task B1: 后端 — HistogramData 加 serde rename_all + total_pixels

**Files:**
- Modify: `src-tauri/src/processing/histogram.rs`

- [ ] **Step 1: 修改结构体与 compute 函数**

把 `src-tauri/src/processing/histogram.rs` 整个文件改为：

```rust
//! 处理后图像的 R/G/B/Luminance 直方图计算。

use image::{ImageBuffer, Rgb};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistogramData {
    pub r: Vec<u32>,
    pub g: Vec<u32>,
    pub b: Vec<u32>,
    pub luma: Vec<u32>,
    pub total_pixels: u32,
}

/// 从 16-bit RGB 图像计算 256-bin 直方图。
///
/// R/G/B 各通道将 u16 值右移 8 位映射到 0-255 bin。
/// Luminance 使用 Rec.709 系数计算后映射到 0-255 bin。
/// total_pixels 用于前端计算高光/阴影裁剪百分比。
pub fn compute(img: &ImageBuffer<Rgb<u16>, Vec<u16>>) -> HistogramData {
    let mut r = vec![0u32; 256];
    let mut g = vec![0u32; 256];
    let mut b = vec![0u32; 256];
    let mut luma = vec![0u32; 256];

    for pixel in img.pixels() {
        let Rgb([rv, gv, bv]) = *pixel;
        let ri = (rv >> 8) as usize;
        let gi = (gv >> 8) as usize;
        let bi = (bv >> 8) as usize;
        r[ri] += 1;
        g[gi] += 1;
        b[bi] += 1;

        let luma_f = 0.2126 * rv as f32 + 0.7152 * gv as f32 + 0.0722 * bv as f32;
        let li = ((luma_f / 65535.0) * 255.0).round() as usize;
        let li = li.min(255);
        luma[li] += 1;
    }

    let (w, h) = img.dimensions();
    HistogramData {
        r,
        g,
        b,
        luma,
        total_pixels: w * h,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageBuffer;

    #[test]
    fn compute_counts_pixels_per_bin() {
        // 4 pixels:
        // x=0 black     => R=0,   G=0,   B=0
        // x=1 white     => R=255, G=255, B=255
        // x=2 red mid   => R=128, G=0,   B=0
        // x=3 green mid => R=0,   G=128, B=0
        let img: ImageBuffer<Rgb<u16>, Vec<u16>> = ImageBuffer::from_fn(4, 1, |x, _| match x {
            0 => Rgb([0, 0, 0]),
            1 => Rgb([65535, 65535, 65535]),
            2 => Rgb([32768, 0, 0]),
            _ => Rgb([0, 32768, 0]),
        });
        let h = compute(&img);

        assert_eq!(h.total_pixels, 4);

        // R: 0,255,128,0 => bin 0:2, 128:1, 255:1
        assert_eq!(h.r[0], 2);
        assert_eq!(h.r[128], 1);
        assert_eq!(h.r[255], 1);

        // G: 0,255,0,128 => bin 0:2, 128:1, 255:1
        assert_eq!(h.g[0], 2);
        assert_eq!(h.g[128], 1);
        assert_eq!(h.g[255], 1);

        // B: 0,255,0,0 => bin 0:3, 255:1
        assert_eq!(h.b[0], 3);
        assert_eq!(h.b[255], 1);

        // luma: black -> bin 0, white -> bin 255 (中间两个红/绿小，luma 大约在 27/95)
        assert_eq!(h.luma[0], 1);
        assert_eq!(h.luma[255], 1);
    }

    #[test]
    fn compute_total_pixels_matches_dimensions() {
        let img: ImageBuffer<Rgb<u16>, Vec<u16>> =
            ImageBuffer::from_pixel(7, 5, Rgb([100, 200, 300]));
        let h = compute(&img);
        assert_eq!(h.total_pixels, 35);
    }
}
```

- [ ] **Step 2: 运行测试**

Run: `cd /Users/ry2019/private/FujiSim/src-tauri && cargo test histogram`
Expected: 2 tests passed。

- [ ] **Step 3: clippy**

Run: `cd /Users/ry2019/private/FujiSim/src-tauri && cargo clippy --all-targets --all-features -- -D warnings`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src-tauri/src/processing/histogram.rs
git commit -m "feat(histogram): add total_pixels + serde camelCase + unit tests"
```

---

### Task B2: 后端 — PreviewResult 加 serde rename_all（统一规范）

**Files:**
- Modify: `src-tauri/src/ipc/preview.rs`

- [ ] **Step 1: 给 PreviewResult 加属性**

把 `src-tauri/src/ipc/preview.rs:13-19` 改为：

```rust
/// 预览结果。前端用 convertFileSrc(path) 加载本地文件，零 IPC 传输开销。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
}
```

- [ ] **Step 2: 编译验证**

Run: `cd /Users/ry2019/private/FujiSim/src-tauri && cargo check`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src-tauri/src/ipc/preview.rs
git commit -m "chore(preview): add #[serde(rename_all)] to PreviewResult per CLAUDE.md §4"
```

---

### Task B3: 前端 — HistogramData 类型加 luma + totalPixels

**Files:**
- Modify: `src/types.ts:189`

- [ ] **Step 1: 修改类型**

把 `src/types.ts:189` 行：

```ts
export type HistogramData = { r: number[]; g: number[]; b: number[]; luma: number[] };
```

改为：

```ts
export type HistogramData = {
  r: number[];
  g: number[];
  b: number[];
  luma: number[];
  totalPixels: number;
};
```

- [ ] **Step 2: TypeScript 检查**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit`
Expected: 通过（前端代码尚未消费 luma/totalPixels，只是新增字段不会破坏）。

- [ ] **Step 3: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src/types.ts
git commit -m "feat(types): expose luma + totalPixels in HistogramData"
```

---

## 阶段 c：直方图视觉升级

### Task C1: Histogram.tsx — luma 通道叠底层

**Files:**
- Modify: `src/components/Histogram.tsx`

- [ ] **Step 1: 修改 drawHistogram 函数**

把 `src/components/Histogram.tsx:9-74` 段（整个 `drawHistogram` 函数）替换为：

```tsx
function drawHistogram(
  canvas: HTMLCanvasElement,
  container: HTMLDivElement,
  data: HistogramData | null,
  height: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth;
  const h = height;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Background
  ctx.fillStyle = "rgb(24 24 27)";
  ctx.fillRect(0, 0, w, h);

  if (!data) return;

  const { r, g, b, luma } = data;
  const bins = 256;

  // Apply sqrt compression to each bin to prevent sharp peaks
  // (e.g. highlight clipping) from dominating the display.
  // This matches Lightroom's approach where the y-axis is non-linear.
  const sqrtR = r.map((v) => Math.sqrt(v));
  const sqrtG = g.map((v) => Math.sqrt(v));
  const sqrtB = b.map((v) => Math.sqrt(v));
  const sqrtLuma = luma.map((v) => Math.sqrt(v));

  // Global max for RGB uses the joint max so additive blending stays balanced.
  let rgbMax = 0;
  for (let i = 0; i < bins; i++) {
    rgbMax = Math.max(rgbMax, sqrtR[i], sqrtG[i], sqrtB[i]);
  }
  // Luma uses its own max — sharing rgbMax would crush luma flat
  // because luma distributions are typically narrower/taller per bin.
  let lumaMax = 0;
  for (let i = 0; i < bins; i++) {
    lumaMax = Math.max(lumaMax, sqrtLuma[i]);
  }

  if (rgbMax === 0 && lumaMax === 0) return;

  const drawChannel = (channel: number[], maxVal: number, color: string) => {
    if (maxVal === 0) return;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < bins; i++) {
      const x = (i / (bins - 1)) * w;
      const y = h - (channel[i] / maxVal) * (h - 1);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };

  // 1) Luma underneath, source-over (gray fill, no blending)
  ctx.globalCompositeOperation = "source-over";
  drawChannel(sqrtLuma, lumaMax, "rgba(220,220,220,0.35)");

  // 2) RGB on top with additive blend so overlaps form natural secondaries
  ctx.globalCompositeOperation = "lighter";
  drawChannel(sqrtR, rgbMax, "rgba(180,40,40,0.65)");
  drawChannel(sqrtG, rgbMax, "rgba(40,150,40,0.65)");
  drawChannel(sqrtB, rgbMax, "rgba(40,60,180,0.65)");

  ctx.globalCompositeOperation = "source-over";
}
```

- [ ] **Step 2: 启动 dev 验证**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tauri dev`
手动验证：选一张图，直方图底层应有淡灰色 luma 曲线垫底，RGB 三色叠加在上面。Ctrl+C 停止。

- [ ] **Step 3: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src/components/Histogram.tsx
git commit -m "feat(histogram): add luma channel under RGB with independent normalization"
```

---

### Task C2: i18n — 新增直方图相关翻译键

**Files:**
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 1: 在 zh.ts 添加 histogram 段**

在 `src/i18n/zh.ts` 中 `filterPanel: { ... }` 段之前（或之后，保持顶层结构）插入新的顶层键：

```ts
  histogram: {
    shadowClip: "阴影裁剪 {{percent}}%",
    highlightClip: "高光裁剪 {{percent}}%",
    channels: {
      r: "R",
      g: "G",
      b: "B",
      luma: "亮度",
    },
  },
```

- [ ] **Step 2: 在 en.ts 添加对应英文**

在 `src/i18n/en.ts` 对称位置插入：

```ts
  histogram: {
    shadowClip: "Shadow Clip {{percent}}%",
    highlightClip: "Highlight Clip {{percent}}%",
    channels: {
      r: "R",
      g: "G",
      b: "B",
      luma: "Luma",
    },
  },
```

- [ ] **Step 3: TypeScript 检查**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit`
Expected: 通过（i18n 是 TS 类型推断的，新增段不会破坏其他翻译）。

- [ ] **Step 4: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src/i18n/zh.ts src/i18n/en.ts
git commit -m "i18n(histogram): add shadow/highlight clip + channel labels"
```

---

### Task C3: Histogram.tsx — 裁剪警告 + 通道图例

**Files:**
- Modify: `src/components/Histogram.tsx`

- [ ] **Step 1: 重写组件正文**

把 `src/components/Histogram.tsx:76-103`（`export function Histogram` 整个函数）替换为：

```tsx
export function Histogram({ data, height = 120 }: HistogramProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizeKey, setResizeKey] = useState(0);

  const handleResize = useCallback(() => setResizeKey((k) => k + 1), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    drawHistogram(canvas, container, data, height);
  }, [data, height, resizeKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [handleResize]);

  const clip = computeClip(data);

  return (
    <div className="w-full">
      <div className="flex items-center gap-3 px-2 py-1 text-[10px] text-zinc-400">
        <ChannelDot color="rgb(220,220,220)" label={t("histogram.channels.luma")} />
        <ChannelDot color="rgb(220,80,80)" label={t("histogram.channels.r")} />
        <ChannelDot color="rgb(80,200,80)" label={t("histogram.channels.g")} />
        <ChannelDot color="rgb(100,120,220)" label={t("histogram.channels.b")} />
      </div>
      <div ref={containerRef} className="relative w-full rounded overflow-hidden">
        <canvas ref={canvasRef} />
        {clip.shadow > 0.005 && (
          <div
            className="absolute top-1 left-1 w-0 h-0"
            style={{
              borderLeft: "5px solid transparent",
              borderRight: "5px solid transparent",
              borderTop: "6px solid rgb(80,140,255)",
            }}
            title={t("histogram.shadowClip", { percent: (clip.shadow * 100).toFixed(1) })}
          />
        )}
        {clip.highlight > 0.005 && (
          <div
            className="absolute top-1 right-1 w-0 h-0"
            style={{
              borderLeft: "5px solid transparent",
              borderRight: "5px solid transparent",
              borderTop: "6px solid rgb(255,90,90)",
            }}
            title={t("histogram.highlightClip", { percent: (clip.highlight * 100).toFixed(1) })}
          />
        )}
      </div>
    </div>
  );
}

function ChannelDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function computeClip(data: HistogramData | null): { shadow: number; highlight: number } {
  if (!data || data.totalPixels === 0) return { shadow: 0, highlight: 0 };
  const total = data.totalPixels * 3;
  const shadow = (data.r[0] + data.g[0] + data.b[0]) / total;
  const highlight = (data.r[255] + data.g[255] + data.b[255]) / total;
  return { shadow, highlight };
}
```

- [ ] **Step 2: 顶部 import 增加 useTranslation**

把 `src/components/Histogram.tsx:1-2` 改为：

```tsx
import { useRef, useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { HistogramData } from "@/types";
```

- [ ] **Step 3: 行数检查**

Run: `wc -l /Users/ry2019/private/FujiSim/src/components/Histogram.tsx`
Expected: 行数 ≤ 250。如超过 200，把 `drawHistogram` 移到 `src/lib/histogramDraw.ts`（本任务暂不强制）。

- [ ] **Step 4: TypeScript + Lint**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit && pnpm lint`
Expected: 通过。

- [ ] **Step 5: 启动 dev 验证**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tauri dev`
手动验证：
1. 顶部应显示 4 个色点 + 标签（亮度/R/G/B）
2. 选一张过曝图，右上角应有红色三角；hover 显示百分比
3. 选一张欠曝图，左上角应有蓝色三角
4. Ctrl+C 停止

- [ ] **Step 6: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src/components/Histogram.tsx
git commit -m "feat(histogram): add clipping warnings and channel legend"
```

---

## 阶段 d：FilterPanel 拆分

### Task D1: 准备拆分 — 创建目录结构

**Files:**
- Create: `src/components/FilterPanel/` 目录

- [ ] **Step 1: 创建目录占位**

Run: `mkdir -p /Users/ry2019/private/FujiSim/src/components/FilterPanel`
Expected: 目录创建成功，`ls /Users/ry2019/private/FujiSim/src/components/FilterPanel` 返回空。

不 commit，留到 D9 一并提交。

---

### Task D2: 拆分 — SideTabTrigger.tsx

**Files:**
- Create: `src/components/FilterPanel/SideTabTrigger.tsx`

- [ ] **Step 1: 写文件**

写入 `src/components/FilterPanel/SideTabTrigger.tsx`：

```tsx
import { TabsTrigger } from "@/components/ui/tabs";

export function SideTabTrigger({
  value,
  label,
  icon,
}: {
  value: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <TabsTrigger
      value={value}
      aria-label={label}
      className="group relative h-9 w-full p-0 flex items-center justify-center"
    >
      {icon}
      <span
        role="tooltip"
        className="pointer-events-none absolute right-full mr-2 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md bg-zinc-900 text-zinc-100 text-xs px-2 py-1 shadow-lg border border-zinc-700/60 opacity-0 translate-x-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0 z-50"
      >
        {label}
      </span>
    </TabsTrigger>
  );
}
```

不 commit。

---

### Task D3: 拆分 — HistogramSection.tsx

**Files:**
- Create: `src/components/FilterPanel/HistogramSection.tsx`

- [ ] **Step 1: 写文件**

写入 `src/components/FilterPanel/HistogramSection.tsx`：

```tsx
import { useStore } from "@/store";
import { Histogram } from "@/components/Histogram";

export function HistogramSection() {
  const histogram = useStore((s) => s.histogram);
  return <Histogram data={histogram} />;
}
```

不 commit。

注：`useHistogramSync` 仍保留在 PreviewPanel 中调用（阶段 a 已建立），本阶段不搬移以减少回归面。

---

### Task D4: 拆分 — WhiteBalanceSection.tsx

**Files:**
- Create: `src/components/FilterPanel/WhiteBalanceSection.tsx`

- [ ] **Step 1: 写文件**

写入 `src/components/FilterPanel/WhiteBalanceSection.tsx`：

```tsx
import { useState } from "react";
import { Thermometer, RotateCcw, Pipette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Section } from "@/components/ui/section";
import { SliderRow } from "@/components/ui/form";
import { useStore } from "@/store";
import { api } from "@/api";

export function WhiteBalanceSection() {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const focusedId = useStore((s) => s.focusedId);
  const eyedropperMode = useStore((s) => s.eyedropperMode);
  const setEyedropperMode = useStore((s) => s.setEyedropperMode);
  const [wbMode, setWbMode] = useState<"reset" | "auto">("reset");

  return (
    <Section title={t("editor.sections.whiteBalance")} icon={<Thermometer size={12} />}>
      <div className="flex items-center gap-1.5">
        <Select
          value={wbMode}
          onValueChange={(v) => {
            if (v === "auto") {
              if (!focusedId) return;
              api.autoWhiteBalance(focusedId).then((result) => {
                setFilter({
                  wb_shift_r: result.wbShiftR,
                  wb_shift_g: result.wbShiftG,
                  wb_shift_b: result.wbShiftB,
                });
                setWbMode("auto");
              });
            }
          }}
        >
          <SelectTrigger className="h-6 w-auto gap-1 border-zinc-700 bg-zinc-900 text-[10px] text-zinc-300 px-2 py-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-zinc-700 bg-zinc-900">
            <SelectItem
              value="reset"
              className="text-[10px] text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100"
            >
              {t("filterPanel.wbReset")}
            </SelectItem>
            <SelectItem
              value="auto"
              className="text-[10px] text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100"
            >
              {t("filterPanel.wbAuto")}
            </SelectItem>
          </SelectContent>
        </Select>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          className="h-6 w-6 p-0 border-zinc-700 hover:bg-zinc-800"
          onClick={() => {
            setFilter({ wb_shift_r: 0, wb_shift_g: 0, wb_shift_b: 0 });
            setWbMode("reset");
          }}
          title={t("filterPanel.wbReset")}
        >
          <RotateCcw size={12} />
        </Button>
        <Button
          size="sm"
          variant={eyedropperMode === "white-balance" ? "default" : "outline"}
          className="h-6 w-6 p-0 border-zinc-700 hover:bg-zinc-800"
          onClick={() =>
            setEyedropperMode(eyedropperMode === "white-balance" ? "none" : "white-balance")
          }
        >
          <Pipette size={12} />
        </Button>
      </div>
      <SliderRow
        label={t("filterPanel.temperature")}
        value={-filter.wb_shift_b}
        min={-100}
        max={100}
        step={1}
        display={(v) => v.toFixed(0)}
        onChange={(v) => {
          setFilter({ wb_shift_b: -v });
          setWbMode("reset");
        }}
        trackGradient="linear-gradient(to right, #4488ff, #cccc88, #ffcc00)"
      />
      <SliderRow
        label={t("filterPanel.tint")}
        value={-filter.wb_shift_g}
        min={-100}
        max={100}
        step={1}
        display={(v) => v.toFixed(0)}
        onChange={(v) => {
          setFilter({ wb_shift_g: -v });
          setWbMode("reset");
        }}
        trackGradient="linear-gradient(to right, #44cc44, #cccccc, #cc44cc)"
      />
    </Section>
  );
}
```

不 commit。

---

### Task D5: 拆分 — BasicAdjustSection.tsx + DetailSection.tsx + GrainSection.tsx

**Files:**
- Create: `src/components/FilterPanel/BasicAdjustSection.tsx`
- Create: `src/components/FilterPanel/DetailSection.tsx`
- Create: `src/components/FilterPanel/GrainSection.tsx`

- [ ] **Step 1: 写 BasicAdjustSection.tsx**

```tsx
import { Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Section } from "@/components/ui/section";
import { SliderRow } from "@/components/ui/form";
import { useStore } from "@/store";
import { PASS_THROUGH_SIM } from "@/types";

export function BasicAdjustSection() {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);

  return (
    <Section title={t("editor.sections.basic")} icon={<Sun size={12} />}>
      {filter.base_simulation === PASS_THROUGH_SIM && filter.lut_file_path && (
        <p className="mb-2 text-[10px] text-zinc-500">{t("filterPanel.lutAppliedNotice")}</p>
      )}
      <SliderRow label={t("filterPanel.exposure")} value={filter.exposure}
        min={-5} max={5} step={0.05} display={(v) => v.toFixed(2)}
        onChange={(v) => setFilter({ exposure: v })} />
      <SliderRow label={t("filterPanel.contrast")} value={filter.contrast}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ contrast: v })} />
      <SliderRow label={t("filterPanel.brightness")} value={filter.brightness}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ brightness: v })} />
      <SliderRow label={t("filterPanel.highlight")} value={filter.highlight_tone}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ highlight_tone: v })} />
      <SliderRow label={t("filterPanel.shadow")} value={filter.shadow_tone}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ shadow_tone: v })} />
      <SliderRow label={t("filterPanel.white")} value={filter.white}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ white: v })} />
      <SliderRow label={t("filterPanel.black")} value={filter.black}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ black: v })} />
      <SliderRow label={t("filterPanel.dehaze")} value={filter.dehaze}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ dehaze: v })} />
      <SliderRow label={t("filterPanel.vibrance")} value={filter.vibrance}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ vibrance: v })} />
      <SliderRow label={t("filterPanel.saturation")} value={filter.color_saturation}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ color_saturation: v })} />
    </Section>
  );
}
```

- [ ] **Step 2: 写 DetailSection.tsx**

```tsx
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Section } from "@/components/ui/section";
import { SliderRow } from "@/components/ui/form";
import { useStore } from "@/store";

export function DetailSection() {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);

  return (
    <Section title={t("editor.sections.detail")} icon={<Sparkles size={12} />}>
      <SliderRow label={t("filterPanel.clarity")} value={filter.clarity}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ clarity: v })} />
      <SliderRow label={t("filterPanel.sharpness")} value={filter.sharpness}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ sharpness: v })} />
    </Section>
  );
}
```

- [ ] **Step 3: 写 GrainSection.tsx**

```tsx
import { Droplets } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Section } from "@/components/ui/section";
import { SliderRow } from "@/components/ui/form";
import { useStore } from "@/store";

export function GrainSection() {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);

  return (
    <Section title={t("editor.sections.grain")} icon={<Droplets size={12} />} defaultOpen={false}>
      <SliderRow label={t("filterPanel.grainAmount")} value={filter.grain_amount}
        min={0} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ grain_amount: v })} />
      <SliderRow label={t("filterPanel.grainSize")} value={filter.grain_size}
        min={0} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ grain_size: v })} />
      <SliderRow label={t("filterPanel.grainRoughness")} value={filter.grain_roughness}
        min={0} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ grain_roughness: v })} />
      <SliderRow label={t("filterPanel.grainColor")} value={filter.grain_color}
        min={0} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ grain_color: v })} />
    </Section>
  );
}
```

不 commit。

---

### Task D6: 拆分 — InfoTab.tsx

**Files:**
- Create: `src/components/FilterPanel/InfoTab.tsx`

- [ ] **Step 1: 写文件**

写入 `src/components/FilterPanel/InfoTab.tsx`：

```tsx
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Info,
  Camera,
  Aperture,
  Timer,
  Ruler,
  Calendar,
  HardDrive,
  Star,
  FileType,
  ImageIcon,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "@/store";
import { formatBytes, shortDate } from "@/lib/utils";

export function InfoTab() {
  const { t } = useTranslation();
  const assets = useStore((s) => s.assets);
  const focusedId = useStore((s) => s.focusedId);
  const focused = assets.find((a) => a?.id === focusedId) ?? null;

  if (!focused) {
    return (
      <div className="flex flex-col items-center justify-center text-zinc-500 py-10 gap-2">
        <Info size={32} />
        <p>{t("filterPanel.noSelection")}</p>
      </div>
    );
  }

  const thumbSrc = focused.cover_path ?? (!focused.is_raw ? focused.file_path : null);

  return (
    <div className="space-y-4 text-xs pt-3">
      <div className="rounded-md border border-zinc-800/80 bg-zinc-900/40 p-3 flex gap-3">
        <div className="w-16 h-16 flex-shrink-0 rounded overflow-hidden bg-zinc-900 border border-zinc-800/60 flex items-center justify-center">
          {thumbSrc ? (
            <img src={convertFileSrc(thumbSrc)} alt="" className="w-full h-full object-cover" draggable={false} />
          ) : (
            <ImageIcon size={20} className="text-zinc-700" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-zinc-100 font-medium truncate" title={focused.file_name}>{focused.file_name}</p>
          <p className="text-zinc-500 break-all leading-relaxed text-[11px]" title={focused.file_path}>{focused.file_path}</p>
        </div>
      </div>

      <InfoGroup>
        <InfoRow Icon={Camera} label={t("filterPanel.metaCamera")} value={focused.camera_model} />
        <InfoRow Icon={ImageIcon} label={t("filterPanel.metaLens")} value={focused.lens_model} />
      </InfoGroup>

      <InfoGroup>
        <InfoRow Icon={Aperture} label={t("filterPanel.metaAperture")}
          value={focused.f_number != null ? `f/${focused.f_number.toFixed(1)}` : null} />
        <InfoRow Icon={Timer} label={t("filterPanel.metaShutter")}
          value={focused.shutter_speed ? `${focused.shutter_speed}s` : null} />
        <InfoRow Icon={Ruler} label={t("filterPanel.metaFocal")}
          value={focused.focal_length != null ? `${focused.focal_length}mm` : null} />
      </InfoGroup>

      <InfoGroup>
        <InfoRow Icon={Calendar} label={t("filterPanel.metaDate")} value={shortDate(focused.date_taken)} />
        <InfoRow Icon={HardDrive} label={t("filterPanel.metaSize")} value={formatBytes(focused.file_size)} />
        <InfoRow Icon={FileType} label={t("filterPanel.metaType")}
          value={focused.file_type || (focused.is_raw ? "RAW" : null)} />
        <InfoRow Icon={Star} label={t("filterPanel.metaRating")}
          valueNode={
            <div className="flex items-center gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star key={n} size={11}
                  className={n <= focused.star_rating ? "text-amber-400 fill-amber-400" : "text-zinc-700"} />
              ))}
            </div>
          } />
      </InfoGroup>
    </div>
  );
}

function InfoGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/40 divide-y divide-zinc-800/60">
      {children}
    </div>
  );
}

function InfoRow({
  Icon, label, value, valueNode,
}: {
  Icon: LucideIcon;
  label: string;
  value?: string | null;
  valueNode?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 min-w-0">
      <Icon size={12} className="text-zinc-500 flex-shrink-0" />
      <span className="text-zinc-500 text-[11px] flex-shrink-0">{label}</span>
      <div className="ml-auto min-w-0 text-right">
        {valueNode ?? (
          <span className="text-zinc-200 truncate block" title={value ?? undefined}>
            {value || "—"}
          </span>
        )}
      </div>
    </div>
  );
}
```

不 commit。

---

### Task D7: 拆分 — SavePresetDialog.tsx

**Files:**
- Create: `src/components/FilterPanel/SavePresetDialog.tsx`

- [ ] **Step 1: 写文件**

写入 `src/components/FilterPanel/SavePresetDialog.tsx`：

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStore } from "@/store";
import { api } from "@/api";

interface SavePresetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SavePresetDialog({ open, onOpenChange }: SavePresetDialogProps) {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const refreshPresets = useStore((s) => s.refreshPresets);
  const categories = useStore((s) => s.categories);

  const [saveName, setSaveName] = useState("");
  const [saveCategoryId, setSaveCategoryId] = useState<string>("__none__");

  useEffect(() => {
    if (!open) {
      setSaveName("");
      setSaveCategoryId("__none__");
    }
  }, [open]);

  async function handleSave() {
    if (!saveName.trim()) return;
    await api.savePreset({
      name: saveName.trim(),
      base_simulation: filter.base_simulation,
      grain_amount: filter.grain_amount,
      grain_size: filter.grain_size,
      grain_roughness: filter.grain_roughness,
      grain_color: filter.grain_color,
      exposure: filter.exposure,
      contrast: filter.contrast,
      brightness: filter.brightness,
      highlight_tone: filter.highlight_tone,
      shadow_tone: filter.shadow_tone,
      white: filter.white,
      black: filter.black,
      dehaze: filter.dehaze,
      vibrance: filter.vibrance,
      color_saturation: filter.color_saturation,
      clarity: filter.clarity,
      sharpness: filter.sharpness,
      wb_shift_r: filter.wb_shift_r,
      wb_shift_g: filter.wb_shift_g,
      wb_shift_b: filter.wb_shift_b,
      lut_file_path: filter.lut_file_path ?? null,
      is_builtin: false,
      category_id: saveCategoryId === "__none__" ? null : Number(saveCategoryId),
    });
    onOpenChange(false);
    await refreshPresets();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{t("filterPanel.savePresetTitle")}</DialogTitle>
        <DialogDescription>{t("filterPanel.savePresetDesc")}</DialogDescription>
        <Input
          className="mt-3"
          value={saveName}
          placeholder={t("filterPanel.savePresetPlaceholder")}
          onChange={(e) => setSaveName(e.target.value)}
        />
        <div className="mt-3 space-y-1">
          <label className="text-xs text-zinc-400">{t("filterPanel.savePresetCategory")}</label>
          <Select value={saveCategoryId} onValueChange={setSaveCategoryId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("editor.presetList.noCategory")}</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave}>{t("common.save")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

不 commit。

---

### Task D8: 拆分 — index.tsx 编排骨架

**Files:**
- Create: `src/components/FilterPanel/index.tsx`

- [ ] **Step 1: 写文件**

写入 `src/components/FilterPanel/index.tsx`：

```tsx
import { useEffect, useState } from "react";
import {
  Save,
  SlidersHorizontal,
  Stamp,
  ScrollText,
  Palette,
  TrendingUp,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/section";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useStore } from "@/store";
import { HslPanel } from "@/components/HslPanel";
import { CurvesEditor } from "@/components/CurvesEditor";
import { WatermarkTab } from "@/components/WatermarkTab";
import type { ToneCurvePoints } from "@/types";

import { SideTabTrigger } from "./SideTabTrigger";
import { HistogramSection } from "./HistogramSection";
import { WhiteBalanceSection } from "./WhiteBalanceSection";
import { BasicAdjustSection } from "./BasicAdjustSection";
import { DetailSection } from "./DetailSection";
import { GrainSection } from "./GrainSection";
import { InfoTab } from "./InfoTab";
import { SavePresetDialog } from "./SavePresetDialog";

export function FilterPanel() {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const resetFilter = useStore((s) => s.resetFilter);
  const refreshPresets = useStore((s) => s.refreshPresets);

  const [saveOpen, setSaveOpen] = useState(false);

  useEffect(() => {
    refreshPresets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <aside className="w-full h-full bg-transparent flex text-sm overflow-hidden">
      <Tabs defaultValue="adjust" className="flex-1 flex flex-row-reverse overflow-hidden">
        <TabsList className="flex flex-col h-full w-11 flex-shrink-0 items-stretch gap-1 rounded-none bg-zinc-900/50 border-l border-zinc-800/60 p-1">
          <SideTabTrigger value="adjust" label={t("filterPanel.tabs.adjust")} icon={<SlidersHorizontal size={16} />} />
          <SideTabTrigger value="watermark" label={t("filterPanel.tabs.watermark")} icon={<Stamp size={16} />} />
          <SideTabTrigger value="info" label={t("filterPanel.tabs.info")} icon={<ScrollText size={16} />} />
        </TabsList>

        <TabsContent
          value="adjust"
          className="flex-1 min-w-0 overflow-hidden mt-0 data-[state=active]:flex data-[state=active]:flex-col select-none"
        >
          <ScrollArea className="flex-1">
            <div className="px-0 py-0 space-y-2">
              <HistogramSection />
              <WhiteBalanceSection />
              <BasicAdjustSection />
              <Section title={t("hsl.title")} icon={<Palette size={12} />} defaultOpen={false}>
                <HslPanel />
              </Section>
              <Section title={t("editor.sections.curves")} icon={<TrendingUp size={12} />} defaultOpen={false}>
                <CurvesEditor
                  value={filter.tone_curve}
                  onChange={(tc: ToneCurvePoints) => setFilter({ tone_curve: tc })}
                />
              </Section>
              <DetailSection />
              <GrainSection />
            </div>
          </ScrollArea>

          <div className="flex gap-2 px-3 py-3 border-t border-zinc-800/60">
            <Button size="sm" variant="outline" onClick={resetFilter} className="flex-1 border-zinc-800 hover:bg-zinc-800">
              {t("common.reset")}
            </Button>
            <Button size="sm" variant="default" onClick={() => setSaveOpen(true)} className="flex-1">
              <Save size={12} /> {t("filterPanel.saveAsPreset")}
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="watermark"
          className="flex-1 min-w-0 overflow-hidden mt-0 data-[state=active]:flex data-[state=active]:flex-col select-none">
          <WatermarkTab />
        </TabsContent>

        <TabsContent value="info" className="flex-1 min-w-0 overflow-y-auto px-3 pb-6 mt-0">
          <InfoTab />
        </TabsContent>
      </Tabs>

      <SavePresetDialog open={saveOpen} onOpenChange={setSaveOpen} />
    </aside>
  );
}
```

不 commit。

---

### Task D9: 删除旧 FilterPanel.tsx + 验证 + 提交

**Files:**
- Delete: `src/components/FilterPanel.tsx`

- [ ] **Step 1: 验证调用方未变**

Run: `grep -rn "from \"@/components/FilterPanel\"" /Users/ry2019/private/FujiSim/src/`
Expected: 仍然指向 `@/components/FilterPanel`（解析为 `FilterPanel/index.tsx`），无需改动调用方。

- [ ] **Step 2: 删除旧文件**

Run: `rm /Users/ry2019/private/FujiSim/src/components/FilterPanel.tsx`

- [ ] **Step 3: TypeScript + Lint**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit && pnpm lint`
Expected: 通过。

- [ ] **Step 4: 行数检查**

Run: `wc -l /Users/ry2019/private/FujiSim/src/components/FilterPanel/*.tsx`
Expected: 每个文件 ≤ 200 行。

- [ ] **Step 5: 启动 dev 完整回归**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tauri dev`
手动验证：
1. 调整 Tab — 所有滑块（白平衡 / 基本 / HSL / 曲线 / 细节 / 颗粒）正常工作
2. 白平衡：滴管模式切换、自动白平衡、还原按钮
3. 直方图：拖滑块时刷新、4 通道显示、裁剪警告
4. 水印 Tab — 正常显示
5. 信息 Tab — 选中照片 / 未选中两种状态
6. 重置滤镜按钮、保存为预设按钮 + 对话框
7. Ctrl+C 停止

- [ ] **Step 6: Commit**

```bash
cd /Users/ry2019/private/FujiSim
git add src/components/FilterPanel/ src/components/FilterPanel.tsx
git commit -m "refactor(filter-panel): split 671-line file into FilterPanel/ directory"
```

---

## 收尾

### Task E1: 全量回归 + 行数审计 + 阶段总结

- [ ] **Step 1: 行数审计**

Run:
```bash
cd /Users/ry2019/private/FujiSim
echo "=== Histogram.tsx ==="
wc -l src/components/Histogram.tsx
echo "=== FilterPanel/ ==="
wc -l src/components/FilterPanel/*.tsx
echo "=== histogram.rs ==="
wc -l src-tauri/src/processing/histogram.rs src-tauri/src/ipc/histogram.rs
```
Expected: 所有文件 ≤ 500 行（项目硬限制），FilterPanel 子文件 ≤ 200 行。

- [ ] **Step 2: 完整测试**

Run: `cd /Users/ry2019/private/FujiSim/src-tauri && cargo test && cargo clippy --all-targets --all-features -- -D warnings`
Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit && pnpm lint`
Expected: 全部通过。

- [ ] **Step 3: dev 跑一次手感对比**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tauri dev`
手感验证：
- 拖动曝光滑块时，直方图刷新明显比预览图更频繁、更轻盈
- RAW 文件 + 不动滑块时，直方图正常显示（不为空）
- 高光/阴影裁剪三角警告正常显示
- 4 通道（亮度 + RGB）叠加效果正确

不 commit（无代码改动）。

---

## 自我审查清单

阅读全部任务后逐项对照 spec 检查：

- ✅ §3.1 后端新增 IPC → Task A2
- ✅ §3.2 PreviewResult 移除 histogram → Task A3
- ✅ §3.3 SharedState 加 histogram_token → Task A1
- ✅ §3.4 lib.rs 注册新命令 → Task A2 Step 3
- ✅ §3.5 前端 PreviewResult 类型 + api.ts 包装 → Task A5
- ✅ §3.6 isIdentityFilter 工具 → Task A4
- ✅ §3.7 useHistogramSync hook → Task A6 Step 1
- ✅ §3.8 PreviewPanel 改动 → Task A6 Step 2
- ✅ §4.1 HistogramData camelCase + total_pixels → Task B1
- ✅ §4.3 单元测试 → Task B1 Step 1
- ✅ §4.x PreviewResult camelCase → Task B2
- ✅ §5.1 luma 通道 → Task C1
- ✅ §5.2 裁剪警告 → Task C3
- ✅ §5.3 i18n → Task C2
- ✅ §6.1 目录结构 → Task D1-D8
- ✅ §6.3 兼容性（调用方零改动）→ Task D9 Step 1

无 placeholder。类型一致：`HistogramData` 在 B1 与 B3 同步加 `total_pixels`/`totalPixels`，`useHistogramSync` 在 A6 定义、D8 中由 PreviewPanel 调用（不变更位置）。

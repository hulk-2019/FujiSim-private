# White Balance Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "White Balance" section above "基础" in the adjust tab, with temperature/tint sliders, reset/auto buttons, and eyedropper color-picking.

**Architecture:** Reuse existing `wb_shift_r`/`wb_shift_b` fields in FilterSettings (no GPU/shader changes). Add eyedropper mode to store, new Tauri commands for auto WB and pixel sampling, and new UI section in FilterPanel.

**Tech Stack:** React + TypeScript (frontend), Rust + Tauri (backend), Zustand (state), i18next (i18n)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/i18n/en.ts` | Modify | Add white balance i18n keys |
| `src/i18n/zh.ts` | Modify | Add white balance i18n keys |
| `src/store/types.ts` | Modify | Add `EyedropperMode` type, `eyedropperMode` to store, `setEyedropperMode` action |
| `src/store/defaults.ts` | Modify | Add `eyedropperMode: 'none'` default |
| `src/store/slices/filter.ts` | Modify | Implement eyedropperMode state/actions |
| `src/components/FilterPanel.tsx` | Modify | Add White Balance Section with sliders and buttons; widen wb_shift_r/b range to -100~100 |
| `src/components/PreviewPanel.tsx` | Modify | Add eyedropper click handling and crosshair cursor |
| `src/api.ts` | Modify | Add `autoWhiteBalance` and `eyedropColor` API calls |
| `src-tauri/src/processing/white_balance.rs` | Create | Auto WB algorithm (Gray World) and pixel sampling |
| `src-tauri/src/processing/mod.rs` | Modify | Register `white_balance` module |
| `src-tauri/src/ipc/preview.rs` | Modify | Add `auto_white_balance` and `eyedrop_color` Tauri commands |
| `src-tauri/src/lib.rs` | Modify | Register new commands |

---

### Task 1: Add i18n Keys

**Files:**
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh.ts`

- [ ] **Step 1: Add keys to `src/i18n/en.ts`**

Add these keys inside the `filterPanel` object (after the existing keys):

```ts
wbReset: 'Reset',
wbAuto: 'Auto',
temperature: 'Temperature',
tint: 'Tint',
```

Add this key inside the `editor.sections` object:

```ts
whiteBalance: 'White Balance',
```

- [ ] **Step 2: Add keys to `src/i18n/zh.ts`**

Add these keys inside the `filterPanel` object:

```ts
wbReset: '还原设置',
wbAuto: '自动',
temperature: '色温',
tint: '色调',
```

Add this key inside the `editor.sections` object:

```ts
whiteBalance: '白平衡',
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/en.ts src/i18n/zh.ts
git commit -m "feat(i18n): add white balance i18n keys"
```

---

### Task 2: Add Eyedropper Mode to Store

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/defaults.ts`
- Modify: `src/store/slices/filter.ts`

- [ ] **Step 1: Add `EyedropperMode` type and store fields to `src/store/types.ts`**

In `src/store/types.ts`, add the type before the store types:

```ts
export type EyedropperMode = 'none' | 'white-balance';
```

Add `eyedropperMode` to the `FilterSlice` interface (alongside other filter state):

```ts
eyedropperMode: EyedropperMode;
```

Add `setEyedropperMode` to the `FilterSliceActions` interface:

```ts
setEyedropperMode: (mode: EyedropperMode) => void;
```

- [ ] **Step 2: Add default value to `src/store/defaults.ts`**

Add to the defaults object:

```ts
eyedropperMode: 'none' as EyedropperMode,
```

- [ ] **Step 3: Implement actions in `src/store/slices/filter.ts`**

Add `setEyedropperMode` action in the slice:

```ts
setEyedropperMode: (state, action: PayloadAction<EyedropperMode>) => {
  state.eyedropperMode = action.payload;
},
```

Make sure `EyedropperMode` is imported from `src/store/types.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/store/types.ts src/store/defaults.ts src/store/slices/filter.ts
git commit -m "feat(store): add eyedropper mode state for white balance"
```

---

### Task 3: Add Rust Backend - Auto White Balance & Eyedropper

**Files:**
- Create: `src-tauri/src/processing/white_balance.rs`
- Modify: `src-tauri/src/processing/mod.rs`
- Modify: `src-tauri/src/ipc/preview.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create `src-tauri/src/processing/white_balance.rs`**

```rust
use image::GenericImageView;

/// Compute auto white balance using Gray World algorithm.
/// Returns (wb_shift_r, wb_shift_b) in range -100..100.
pub fn auto_white_balance(img: &image::DynamicImage) -> (f32, f32) {
    let (width, height) = img.dimensions();
    let total_pixels = width as f64 * height as f64;

    let mut sum_r: f64 = 0.0;
    let mut sum_g: f64 = 0.0;
    let mut sum_b: f64 = 0.0;

    for pixel in img.pixels() {
        let rgba = pixel.2;
        sum_r += f64::from(rgba[0]);
        sum_g += f64::from(rgba[1]);
        sum_b += f64::from(rgba[2]);
    }

    let avg_r = sum_r / total_pixels;
    let avg_g = sum_g / total_pixels;
    let avg_b = sum_b / total_pixels;

    if avg_g == 0.0 {
        return (0.0, 0.0);
    }

    // Shift: positive means warm (more red) for r, cool (more blue) for b.
    // If avg_r > avg_g, image is too warm → negative shift to compensate.
    let wb_shift_r = ((avg_g - avg_r) / avg_g * 100.0).clamp(-100.0, 100.0) as f32;
    let wb_shift_b = ((avg_g - avg_b) / avg_g * 100.0).clamp(-100.0, 100.0) as f32;

    (wb_shift_r, wb_shift_b)
}

/// Sample a single pixel's RGB from the image at (x, y).
/// Returns (R, G, B) as f32 values 0..255.
pub fn eyedrop_color(img: &image::DynamicImage, x: u32, y: u32) -> (f32, f32, f32) {
    let pixel = img.get_pixel(x, y);
    (
        f32::from(pixel[0]),
        f32::from(pixel[1]),
        f32::from(pixel[2]),
    )
}
```

- [ ] **Step 2: Register module in `src-tauri/src/processing/mod.rs`**

Add at the end of the module declarations:

```rust
pub mod white_balance;
```

- [ ] **Step 3: Add Tauri commands in `src-tauri/src/ipc/preview.rs`**

Add these two commands (follow the pattern of existing commands in this file that access `ProcessingState`):

```rust
#[tauri::command]
pub fn auto_white_balance(
    state: State<'_, ProcessingState>,
    asset_id: String,
) -> Result<(f32, f32), String> {
    let guard = state.pipeline.lock().map_err(|e| e.to_string())?;
    let pipeline = guard.as_ref().ok_or("No pipeline initialized")?;
    let asset = pipeline
        .get_asset(&asset_id)
        .ok_or("Asset not found")?;
    let img = &asset.source_image;
    let (r, b) = crate::processing::white_balance::auto_white_balance(img);
    Ok((r, b))
}

#[tauri::command]
pub fn eyedrop_color(
    state: State<'_, ProcessingState>,
    asset_id: String,
    x: u32,
    y: u32,
) -> Result<(f32, f32, f32), String> {
    let guard = state.pipeline.lock().map_err(|e| e.to_string())?;
    let pipeline = guard.as_ref().ok_or("No pipeline initialized")?;
    let asset = pipeline
        .get_asset(&asset_id)
        .ok_or("Asset not found")?;
    let img = &asset.source_image;
    let (r, g, b) = crate::processing::white_balance::eyedrop_color(img, x, y);
    Ok((r, g, b))
}
```

Note: The exact field names (`source_image`, `get_asset`) may vary — verify against the actual `ProcessingPipeline` and asset types before writing. Adapt `pipeline.get_asset(&asset_id)` and `asset.source_image` to match the actual API.

- [ ] **Step 4: Register commands in `src-tauri/src/lib.rs`**

Add `auto_white_balance` and `eyedrop_color` to the `.invoke_handler(tauri::generate_handler![...])` list, following the existing pattern:

```rust
auto_white_balance,
eyedrop_color,
```

- [ ] **Step 5: Build and verify**

Run: `cd src-tauri && cargo build`
Expected: Compiles without errors

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/processing/white_balance.rs src-tauri/src/processing/mod.rs src-tauri/src/ipc/preview.rs src-tauri/src/lib.rs
git commit -m "feat(backend): add auto white balance and eyedropper commands"
```

---

### Task 4: Add Frontend API Functions

**Files:**
- Modify: `src/api.ts`

- [ ] **Step 1: Add API functions to `src/api.ts`**

Add these functions following the existing `invoke` pattern in the file:

```ts
export async function autoWhiteBalance(assetId: string): Promise<{ wb_shift_r: number; wb_shift_b: number }> {
  const [wb_shift_r, wb_shift_b] = await invoke<[number, number]>('auto_white_balance', { assetId });
  return { wb_shift_r, wb_shift_b };
}

export async function eyedropColor(assetId: string, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const [r, g, b] = await invoke<[number, number, number]>('eyedrop_color', { assetId, x, y });
  return { r, g, b };
}
```

Make sure `invoke` is imported from `@tauri-apps/api/core` (should already be imported in this file).

- [ ] **Step 2: Commit**

```bash
git add src/api.ts
git commit -m "feat(api): add autoWhiteBalance and eyedropColor API functions"
```

---

### Task 5: Add White Balance UI Section

**Files:**
- Modify: `src/components/FilterPanel.tsx`

- [ ] **Step 1: Add White Balance Section above the "基础" Section**

In `FilterPanel.tsx`, locate where the "基础" Section is rendered in the adjust tab. Insert a new Section block **before** it.

The White Balance Section should:

1. Use the `Section` component with `icon={Palette}` and title from i18n `t('editor.sections.whiteBalance')`
2. Include a button row with three buttons: "还原设置" (`t('filterPanel.wbReset')`), "自动" (`t('filterPanel.wbAuto')`), and a Pipette icon button
3. Include a `SliderRow` for "色温" mapped to `wb_shift_b` with range -100~100, step 1
4. Include a `SliderRow` for "色调" mapped to `wb_shift_r` with range -100~100, step 1

**Button handlers:**

- **Reset button**: calls `setFilter({ wb_shift_r: 0, wb_shift_b: 0 })`
- **Auto button**: calls `autoWhiteBalance(activeAssetId)` then `setFilter({ wb_shift_r: result.wb_shift_r, wb_shift_b: result.wb_shift_b })`
- **Pipette button**: calls `setEyedropperMode(eyedropperMode === 'white-balance' ? 'none' : 'white-balance')`, toggles active state styling

**Imports needed:**

```ts
import { Palette, Pipette } from 'lucide-react';
import { autoWhiteBalance } from '@/api';
```

Note: `Pipette` may be named `Eyedropper` in some lucide-react versions — verify and use the correct name. Also ensure `setEyedropperMode` and `eyedropperMode` are read from the store.

- [ ] **Step 2: Update existing wb_shift_r/b sliders**

In the "基础" Section, **remove** the existing `wb_shift_r` and `wb_shift_b` `SliderRow`s (they are now in the White Balance section with a wider range). This avoids duplication.

- [ ] **Step 3: Verify visually**

Run: `pnpm dev`
Expected: White Balance section appears above 基础, sliders work, reset clears values, auto triggers backend call

- [ ] **Step 4: Commit**

```bash
git add src/components/FilterPanel.tsx
git commit -m "feat(ui): add white balance section with temperature/tint sliders and buttons"
```

---

### Task 6: Add Eyedropper Interaction to Preview Panel

**Files:**
- Modify: `src/components/PreviewPanel.tsx`

- [ ] **Step 1: Add eyedropper click handler and cursor styling**

In `PreviewPanel.tsx`:

1. Read `eyedropperMode` from the store
2. When `eyedropperMode !== 'none'`, apply `cursor: crosshair` style to the preview image container
3. Add an `onClick` handler on the preview image that:
   - Only fires when `eyedropperMode !== 'none'`
   - Gets click coordinates relative to the image element
   - Scales coordinates to image pixel space (consider the display size vs actual image size)
   - Calls `eyedropColor(activeAssetId, x, y)` to get RGB
   - Computes `wb_shift_r` and `wb_shift_b` using the neutral-gray formula:
     ```ts
     const avg = (r + g + b) / 3;
     const wb_shift_r = Math.round(Math.max(-100, Math.min(100, ((avg - r) / avg) * 100)));
     const wb_shift_b = Math.round(Math.max(-100, Math.min(100, ((avg - b) / avg) * 100))));
     ```
   - Updates filter via `setFilter({ wb_shift_r, wb_shift_b })`
   - Resets eyedropper mode: `setEyedropperMode('none')`

**Imports needed:**

```ts
import { eyedropColor } from '@/api';
import { setEyedropperMode } from '@/store/slices/filter'; // or however the store actions are accessed
```

- [ ] **Step 2: Verify interactively**

Run: `pnpm dev`
Expected:
1. Click Pipette button → cursor changes to crosshair on preview
2. Click a spot on the preview image → sliders update with computed values
3. Eyedropper mode exits automatically after clicking

- [ ] **Step 3: Commit**

```bash
git add src/components/PreviewPanel.tsx
git commit -m "feat(ui): add eyedropper color picking for white balance"
```

---

### Task 7: Final Integration Verification

- [ ] **Step 1: Run lint check**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 2: Run Rust checks**

Run: `cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings`
Expected: No warnings

- [ ] **Step 3: Manual end-to-end test**

Run: `pnpm dev` + `cd src-tauri && cargo run`

Verify:
1. White Balance section appears above 基础 in the adjust tab
2. 色温 and 色调 sliders range from -100 to 100
3. "还原设置" resets both sliders to 0
4. "自动" calculates and sets white balance values
5. Pipette button activates eyedropper mode with crosshair cursor
6. Clicking preview image computes and sets white balance, exits eyedropper mode
7. Existing 基础 sliders (exposure, etc.) still work
8. wb_shift_r/b no longer appear in 基础 section (moved to White Balance)

import { create } from "zustand";
import type { AppState } from "./types";
import { createAssetSlice } from "./slices/assets";
import { createFilterSlice } from "./slices/filter";
import { createPresetSlice } from "./slices/presets";
import { createUserLutSlice } from "./slices/userLuts";
import { createCategorySlice } from "./slices/categories";
import { createAlbumSlice } from "./slices/albums";
import { createExportSlice } from "./slices/exports";
import { createWatermarkSlice } from "./slices/watermark";
import { createFontSlice } from "./slices/fonts";
import { createFacetSlice } from "./slices/facets";
import { createCoverSlice } from "./slices/cover";

export { DEFAULT_FILTER } from "./defaults";

/**
 * 应用全局状态（zustand store）。
 *
 * 设计原则：
 * - **唯一真相源**：所有跨组件共享的状态（资产列表、选择集、当前滤镜、预设、进度）都放这；
 * - **action 内置**：避免在组件里写复杂的 setState 链，直接 `useStore(s => s.refreshAssets)`；
 * - **selector 粒度**：组件中只订阅自己需要的字段（如 `useStore(s => s.assets)`），
 *   减少不必要的重渲染。
 *
 * 实现采用 zustand 的 slice 模式：每个 slice 负责自身状态与对应 actions，
 * 跨 slice 调用通过 `get()` 访问完整 `AppState`。
 */
export const useStore = create<AppState>((...a) => ({
  ...createAssetSlice(...a),
  ...createFilterSlice(...a),
  ...createPresetSlice(...a),
  ...createUserLutSlice(...a),
  ...createCategorySlice(...a),
  ...createAlbumSlice(...a),
  ...createExportSlice(...a),
  ...createWatermarkSlice(...a),
  ...createFontSlice(...a),
  ...createFacetSlice(...a),
  ...createCoverSlice(...a),
}));

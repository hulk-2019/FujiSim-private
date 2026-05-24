import type { StateCreator } from "zustand";
import type { FilterPreset, FilterSettings } from "../../types";
import type { AppState, FilterSlice } from "../types";
import { DEFAULT_FILTER } from "../defaults";

/** 从预设中提取可直接写入 filter 的字段，补全可选字段的默认值 */
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
    tone_curve: null,
  };
}

export const createFilterSlice: StateCreator<AppState, [], [], FilterSlice> = (set, get) => ({
  filter: { ...DEFAULT_FILTER },

  setFilter: (patch) => set({ filter: { ...get().filter, ...patch } }),
  resetFilter: () => set({ filter: { ...DEFAULT_FILTER } }),
  applyPreset: (preset) => set({ filter: presetToFilter(preset) }),
});

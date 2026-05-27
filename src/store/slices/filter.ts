import type { StateCreator } from "zustand";
import type { EyedropperMode } from "../types";
import type { FilterPreset, FilterSettings } from "../../types";
import type { AppState, FilterSlice } from "../types";
import { DEFAULT_FILTER, DEFAULT_EYEDROPPER_MODE } from "../defaults";

/** 从预设中提取可直接写入 filter 的字段，补全可选字段的默认值 */
function presetToFilter(preset: FilterPreset): FilterSettings {
  return {
    ...DEFAULT_FILTER,
    base_simulation: preset.base_simulation,
    grain_amount: preset.grain_amount,
    grain_size: preset.grain_size,
    grain_roughness: preset.grain_roughness,
    grain_color: preset.grain_color,
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
    wb_shift_g: preset.wb_shift_g,
    wb_shift_b: preset.wb_shift_b,
    lut_file_path: preset.lut_file_path ?? null,
  };
}

export const createFilterSlice: StateCreator<AppState, [], [], FilterSlice> = (set, get) => ({
  filter: { ...DEFAULT_FILTER },
  eyedropperMode: DEFAULT_EYEDROPPER_MODE,

  setFilter: (patch) => set({ filter: { ...get().filter, ...patch } }),
  resetFilter: () => set({ filter: { ...DEFAULT_FILTER } }),
  applyPreset: (preset) => set({ filter: presetToFilter(preset) }),
  setEyedropperMode: (mode: EyedropperMode) => set({ eyedropperMode: mode }),
});

import type { FilterSettings } from "../types";

/**
 * 默认的"出厂"滤镜参数。
 * 用作 `resetFilter` 的目标，以及组件挂载时的初始值。
 */
export const DEFAULT_FILTER: FilterSettings = {
  base_simulation: "Pass-Through",
  grain_effect: "None",
  grain_size: "Small",
  color_chrome_effect: "None",
  highlight_tone: 0,
  shadow_tone: 0,
  color_saturation: 0,
  clarity: 0,
  sharpness: 0,
  wb_shift_r: 0,
  wb_shift_b: 0,
  lut_file_path: null,
  tone_curve: null,
};

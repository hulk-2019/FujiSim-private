import type { FilterSettings } from "../types";

/**
 * 默认的"出厂"滤镜参数。
 * 用作 `resetFilter` 的目标，以及组件挂载时的初始值。
 */
export const DEFAULT_FILTER: FilterSettings = {
  base_simulation: "Pass-Through",
  grain_amount: 0,
  grain_size: 0,
  grain_roughness: 0,
  grain_color: 0,
  exposure: 0,
  contrast: 0,
  brightness: 0,
  highlight_tone: 0,
  shadow_tone: 0,
  white: 0,
  black: 0,
  dehaze: 0,
  vibrance: 0,
  color_saturation: 0,
  clarity: 0,
  sharpness: 0,
  wb_shift_r: 0,
  wb_shift_b: 0,
  lut_file_path: null,
  tone_curve: null,
};

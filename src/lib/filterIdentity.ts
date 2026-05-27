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

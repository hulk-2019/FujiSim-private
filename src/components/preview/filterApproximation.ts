import type { FilterSettings } from "@/types";

function hasToneCurvePoints(settings: FilterSettings): boolean {
  const tc = settings.tone_curve;
  if (!tc) return false;
  return tc.rgb.length > 0 || tc.r.length > 0 || tc.g.length > 0 || tc.b.length > 0;
}

export function canApproximateWithGpu(settings: FilterSettings): boolean {
  const passThrough = !settings.base_simulation || settings.base_simulation === "Pass-Through";
  return (
    passThrough &&
    !settings.lut_file_path &&
    !hasToneCurvePoints(settings) &&
    settings.grain_amount === 0 &&
    settings.dehaze === 0 &&
    settings.clarity === 0 &&
    settings.sharpness === 0
  );
}

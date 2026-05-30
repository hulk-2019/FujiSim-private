import { describe, expect, it } from "vitest";
import {
  isImportedWatermarkActive,
  isRecommendedWatermarkActive,
  isSavedWatermarkPresetActive,
} from "@/components/WatermarkPresetPanel";
import { DEFAULT_WATERMARK } from "@/types";

describe("WatermarkPresetPanel card active state", () => {
  it("only marks a recommended watermark active while it is enabled", () => {
    expect(
      isRecommendedWatermarkActive(
        { ...DEFAULT_WATERMARK, enabled: false, source: "builtin", name: "builtin:Clean" },
        "builtin:Clean",
      ),
    ).toBe(false);

    expect(
      isRecommendedWatermarkActive(
        { ...DEFAULT_WATERMARK, enabled: true, source: "builtin", name: "builtin:Clean" },
        "builtin:Clean",
      ),
    ).toBe(true);
  });

  it("only marks an imported svg active while it is enabled", () => {
    expect(
      isImportedWatermarkActive({ ...DEFAULT_WATERMARK, enabled: false, kind: "svg", svgId: 7 }, 7),
    ).toBe(false);

    expect(
      isImportedWatermarkActive({ ...DEFAULT_WATERMARK, enabled: true, kind: "svg", svgId: 7 }, 7),
    ).toBe(true);
  });

  it("only marks a saved preset active while it is enabled", () => {
    expect(isSavedWatermarkPresetActive({ ...DEFAULT_WATERMARK, enabled: false }, 3, 3)).toBe(false);
    expect(isSavedWatermarkPresetActive({ ...DEFAULT_WATERMARK, enabled: true }, 3, 3)).toBe(true);
  });
});

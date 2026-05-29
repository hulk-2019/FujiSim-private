import { describe, expect, it } from "vitest";
import { buildWatermarkSvg } from "@/lib/watermarkSvg";
import { DEFAULT_WATERMARK } from "@/types";

describe("buildWatermarkSvg", () => {
  it("builds a full-canvas svg for a text watermark", () => {
    const svg = buildWatermarkSvg(
      { ...DEFAULT_WATERMARK, enabled: true, kind: "text", text: "FujiSim" },
      1200,
      800,
    );

    expect(svg).toContain("<svg");
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="800"');
    expect(svg).toContain("FujiSim");
  });
});

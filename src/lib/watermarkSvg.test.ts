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

  it("accepts imported svg watermark settings", () => {
    const svg = buildWatermarkSvg(
      {
        ...DEFAULT_WATERMARK,
        enabled: true,
        kind: "svg",
        source: "imported",
        svgId: 7,
        svgMarkup: '<svg viewBox="0 0 10 10"><path fill="currentColor" d="M0 0h10v10H0z"/></svg>',
        svgFillOverride: "#ff0000",
        svgStrokeOverride: "#00ff00",
        svgTextOverride: "Signed",
      },
      400,
      300,
    );

    expect(svg).toContain("#ff0000");
  });
});

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

  it("escapes text and positions bottom-center watermarks", () => {
    const svg = buildWatermarkSvg(
      {
        ...DEFAULT_WATERMARK,
        enabled: true,
        kind: "text",
        text: '<Fuji & "Sim">',
        position: "bottom-center",
        fontSize: 24,
      },
      1000,
      500,
    );

    expect(svg).toContain("&lt;Fuji &amp; &quot;Sim&quot;&gt;");
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('y="484"');
  });

  it("overrides imported svg fill, stroke, and text", () => {
    const svg = buildWatermarkSvg(
      {
        ...DEFAULT_WATERMARK,
        enabled: true,
        kind: "svg",
        source: "imported",
        svgMarkup:
          '<svg viewBox="0 0 20 10"><path fill="currentColor" stroke="#111" d="M0 0h20v10H0z"/><text>Old</text></svg>',
        svgFillOverride: "#abcdef",
        svgStrokeOverride: "#123456",
        svgTextOverride: "New",
      },
      200,
      100,
    );

    expect(svg).toContain('fill="#abcdef"');
    expect(svg).toContain('stroke="#123456"');
    expect(svg).toContain(">New<");
    expect(svg).not.toContain(">Old<");
  });
});

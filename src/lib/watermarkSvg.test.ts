import { describe, expect, it } from "vitest";
import { buildWatermarkSvg, normalizeWatermark, svgToDataUrl, watermarkAnchor } from "@/lib/watermarkSvg";
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

  it("normalizes missing fields from older persisted watermark settings", () => {
    const legacy = {
      enabled: true,
      text: "Legacy",
      position: "bottom-center",
      opacity: undefined,
      scale: undefined,
      rotation: undefined,
      offsetX: undefined,
      offsetY: undefined,
      fontFamily: undefined,
      fontSize: undefined,
      color: undefined,
    } as any;

    const svg = buildWatermarkSvg(legacy, 400, 300);

    expect(svg).toContain("Legacy");
    expect(svg).not.toContain("undefined");
    expect(svg).not.toContain("NaN");
  });

  it("wraps imported svg content without leaking root svg attributes onto a group", () => {
    const svg = buildWatermarkSvg(
      {
        ...DEFAULT_WATERMARK,
        enabled: true,
        kind: "svg",
        source: "imported",
        svgMarkup:
          '<svg width="30" height="20" viewBox="0 0 30 20"><title>Logo</title><path fill="currentColor" d="M0 0h30v20H0z"/></svg>',
      },
      400,
      300,
    );

    expect(svg).toContain("<title>Logo</title>");
    expect(svg).not.toContain("<g width=");
    expect(svg).not.toContain("<g viewBox=");
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
    expect(svg).toContain('y="500"');
    expect(svg).toContain('dy="-16"');
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

  it("encodes svg as a data url", () => {
    expect(svgToDataUrl('<svg width="1" height="1"></svg>')).toMatch(/^data:image\/svg\+xml,/);
  });

  it("exports shared anchor and defaults for backend parity", () => {
    expect(watermarkAnchor("bottom-center", 1000, 500)).toMatchObject({
      x: 500,
      y: 500,
      dy: -16,
      textAnchor: "middle",
      dominantBaseline: "text-after-edge",
    });
    expect(normalizeWatermark({ enabled: true } as any).fontSize).toBe(DEFAULT_WATERMARK.fontSize);
  });
});

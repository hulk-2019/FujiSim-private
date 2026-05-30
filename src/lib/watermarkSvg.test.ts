import { describe, expect, it } from "vitest";
import { buildWatermarkSvg, normalizeWatermark, scaleWatermarkForExport, svgToDataUrl, watermarkAnchor } from "@/lib/watermarkSvg";
import { DEFAULT_WATERMARK } from "@/types";

describe("buildWatermarkSvg", () => {
  it("builds a full-canvas svg for a text watermark", () => {
    const svg = buildWatermarkSvg(
      { ...DEFAULT_WATERMARK, enabled: true, kind: "text", text: "FotoForge" },
      1200,
      800,
    );

    expect(svg).toContain("<svg");
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="800"');
    expect(svg).toContain("FotoForge");
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
        text: '<Foto & "Forge">',
        position: "bottom-center",
        fontSize: 24,
      },
      1000,
      500,
    );

    expect(svg).toContain("&lt;Foto &amp; &quot;Forge&quot;&gt;");
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

  it("applies the configured italic angle to text watermarks", () => {
    const svg = buildWatermarkSvg(
      {
        ...DEFAULT_WATERMARK,
        enabled: true,
        italic: true,
        italicDegree: 22,
      },
      400,
      300,
    );

    expect(svg).toContain('skewX(-22)');
    expect(svg).toContain('translate(200 284) skewX(-22) translate(-200 -284)');
  });

  it("applies the italic angle even when font italic styling is disabled", () => {
    const svg = buildWatermarkSvg(
      {
        ...DEFAULT_WATERMARK,
        enabled: true,
        italic: false,
        italicDegree: 22,
      },
      400,
      300,
    );

    expect(svg).toContain('font-style="normal"');
    expect(svg).toContain('skewX(-22)');
  });

  it("flips watermarks around their own center instead of the anchor point", () => {
    const svg = buildWatermarkSvg(
      {
        ...DEFAULT_WATERMARK,
        enabled: true,
        flipH: true,
        flipV: true,
        scale: 1.4,
      },
      400,
      300,
    );

    expect(svg).toContain('scale(1.4)');
    expect(svg).not.toContain('scale(-1.4 -1.4)');
    expect(svg).toContain('style="transform-box: fill-box; transform-origin: center; transform: scale(-1, -1);"');
    expect(svg).not.toContain('scale(-1.4 -1.4)');
  });

  it("renders text stroke behind the fill when stroke is enabled", () => {
    const svg = buildWatermarkSvg(
      {
        ...DEFAULT_WATERMARK,
        enabled: true,
        strokeEnabled: true,
        strokeColor: "#123456",
        strokeWidth: 3,
      },
      400,
      300,
    );

    expect(svg).toContain('stroke="#123456"');
    expect(svg).toContain('stroke-width="3"');
    expect(svg).toContain('paint-order="stroke fill"');
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).toContain('stroke-linecap="round"');
  });

  it("renders shadow as an svg drop-shadow filter", () => {
    const svg = buildWatermarkSvg(
      {
        ...DEFAULT_WATERMARK,
        enabled: true,
        shadowEnabled: true,
        shadowColor: "#010203",
        shadowBlur: 6,
        shadowOffsetX: 2,
        shadowOffsetY: -3,
      },
      400,
      300,
    );

    expect(svg).toContain("<defs>");
    expect(svg).toContain('filter id="watermark-shadow"');
    expect(svg).toContain("<feGaussianBlur");
    expect(svg).toContain("<feOffset");
    expect(svg).toContain("<feFlood");
    expect(svg).toContain("<feComposite");
    expect(svg).toContain("<feMerge>");
    expect(svg).toContain('dx="2"');
    expect(svg).toContain('dy="-3"');
    expect(svg).toContain('stdDeviation="6"');
    expect(svg).toContain('flood-color="#010203"');
    expect(svg).toContain('filter="url(#watermark-shadow)"');
  });

  it("encodes svg as a data url", () => {
    expect(svgToDataUrl('<svg width="1" height="1"></svg>')).toMatch(/^data:image\/svg\+xml,/);
  });

  it("scales preview-sized watermark values for export overlays", () => {
    const wm = scaleWatermarkForExport(
      {
        ...DEFAULT_WATERMARK,
        previewWidth: 600,
        previewHeight: 400,
        fontSize: 32,
        offsetX: 3,
        offsetY: -4,
        shadowBlur: 2,
        shadowOffsetX: 1,
        shadowOffsetY: -1,
        strokeWidth: 1.5,
        padding: 16,
      },
      6000,
      4000,
    );

    expect(wm.fontSize).toBe(320);
    expect(wm.offsetX).toBe(30);
    expect(wm.offsetY).toBe(-40);
    expect(wm.shadowBlur).toBe(20);
    expect(wm.shadowOffsetX).toBe(10);
    expect(wm.shadowOffsetY).toBe(-10);
    expect(wm.strokeWidth).toBe(15);
    expect(wm.padding).toBe(160);
  });

  it("uses scaled padding when building export-sized watermarks", () => {
    const wm = scaleWatermarkForExport(
      {
        ...DEFAULT_WATERMARK,
        previewWidth: 600,
        previewHeight: 400,
        padding: 16,
        position: "bottom-left",
      },
      6000,
      4000,
    );
    const svg = buildWatermarkSvg(wm, 6000, 4000);

    expect(svg).toContain('x="160"');
    expect(svg).toContain('dy="-160"');
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

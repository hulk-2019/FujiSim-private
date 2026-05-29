import type { WatermarkPosition, WatermarkSettings } from "@/types";

const PADDING = 16;

export function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function anchor(position: WatermarkPosition, width: number, height: number) {
  const pad = PADDING;
  switch (position) {
    case "top-left":
      return { x: pad, y: pad, textAnchor: "start", dominantBaseline: "hanging" };
    case "top-center":
      return { x: width / 2, y: pad, textAnchor: "middle", dominantBaseline: "hanging" };
    case "top-right":
      return { x: width - pad, y: pad, textAnchor: "end", dominantBaseline: "hanging" };
    case "left-center":
      return { x: pad, y: height / 2, textAnchor: "start", dominantBaseline: "middle" };
    case "right-center":
      return { x: width - pad, y: height / 2, textAnchor: "end", dominantBaseline: "middle" };
    case "center":
      return { x: width / 2, y: height / 2, textAnchor: "middle", dominantBaseline: "middle" };
    case "bottom-left":
      return { x: pad, y: height - pad, textAnchor: "start", dominantBaseline: "auto" };
    case "bottom-right":
      return { x: width - pad, y: height - pad, textAnchor: "end", dominantBaseline: "auto" };
    case "bottom-center":
    default:
      return { x: width / 2, y: height - pad, textAnchor: "middle", dominantBaseline: "auto" };
  }
}

function transformFor(wm: WatermarkSettings, x: number, y: number): string {
  const sx = wm.flipH ? -wm.scale : wm.scale;
  const sy = wm.flipV ? -wm.scale : wm.scale;
  return `translate(${wm.offsetX} ${wm.offsetY}) translate(${x} ${y}) rotate(${wm.rotation}) scale(${sx} ${sy}) translate(${-x} ${-y})`;
}

function overrideImportedSvg(svg: string, wm: WatermarkSettings): string {
  let next = svg;
  if (wm.svgTextOverride !== undefined) {
    next = next.replace(
      /<text([^>]*)>[\s\S]*?<\/text>/gi,
      `<text$1>${escapeXml(wm.svgTextOverride)}</text>`,
    );
  }
  if (wm.svgFillOverride) {
    next = next.replace(/\sfill=(["'])(?!none\b)[^"']*\1/gi, ` fill="${wm.svgFillOverride}"`);
    next = next.replace(/currentColor/g, wm.svgFillOverride);
  }
  if (wm.svgStrokeOverride) {
    next = next.replace(/\sstroke=(["'])(?!none\b)[^"']*\1/gi, ` stroke="${wm.svgStrokeOverride}"`);
  }
  return next.replace(/^<svg\b/i, "<g").replace(/<\/svg>\s*$/i, "</g>");
}

export function buildWatermarkSvg(wm: WatermarkSettings, width: number, height: number): string {
  const pos = anchor(wm.position, width, height);
  const x = pos.x;
  const y = pos.y;
  const transform = transformFor(wm, x, y);
  const opacity = Math.max(0, Math.min(1, wm.opacity));

  const body =
    wm.kind === "svg" && wm.svgMarkup
      ? overrideImportedSvg(wm.svgMarkup, wm)
      : `<text x="${x}" y="${y}" text-anchor="${pos.textAnchor}" dominant-baseline="${pos.dominantBaseline}" font-family="${escapeXml(wm.fontFamily)}" font-size="${wm.fontSize}" font-weight="${wm.bold ? 700 : 400}" font-style="${wm.italic ? "italic" : "normal"}" fill="${wm.color}">${escapeXml(wm.text)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g opacity="${opacity}" transform="${transform}">${body}</g></svg>`;
}

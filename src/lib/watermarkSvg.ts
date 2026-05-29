import { DEFAULT_WATERMARK, type WatermarkPosition, type WatermarkSettings } from "@/types";

const PADDING = 16;

export function escapeXml(input: string): string {
  return String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function watermarkAnchor(position: WatermarkPosition, width: number, height: number) {
  const pad = PADDING;
  switch (position) {
    case "top-left":
      return { x: pad, y: 0, dy: pad, textAnchor: "start", dominantBaseline: "hanging" };
    case "top-center":
      return { x: width / 2, y: 0, dy: pad, textAnchor: "middle", dominantBaseline: "hanging" };
    case "top-right":
      return { x: width - pad, y: 0, dy: pad, textAnchor: "end", dominantBaseline: "hanging" };
    case "left-center":
      return { x: pad, y: height / 2, dy: 0, textAnchor: "start", dominantBaseline: "middle" };
    case "right-center":
      return { x: width - pad, y: height / 2, dy: 0, textAnchor: "end", dominantBaseline: "middle" };
    case "center":
      return { x: width / 2, y: height / 2, dy: 0, textAnchor: "middle", dominantBaseline: "middle" };
    case "bottom-left":
      return { x: pad, y: height, dy: -pad, textAnchor: "start", dominantBaseline: "text-after-edge" };
    case "bottom-right":
      return { x: width - pad, y: height, dy: -pad, textAnchor: "end", dominantBaseline: "text-after-edge" };
    case "bottom-center":
    default:
      return { x: width / 2, y: height, dy: -pad, textAnchor: "middle", dominantBaseline: "text-after-edge" };
  }
}

export function normalizeWatermark(wm: WatermarkSettings): WatermarkSettings {
  return {
    ...DEFAULT_WATERMARK,
    ...wm,
    fontFamily: wm.fontFamily ?? DEFAULT_WATERMARK.fontFamily,
    fontSize: wm.fontSize ?? DEFAULT_WATERMARK.fontSize,
    color: wm.color ?? DEFAULT_WATERMARK.color,
    kind: wm.kind ?? DEFAULT_WATERMARK.kind,
    offsetX: wm.offsetX ?? DEFAULT_WATERMARK.offsetX,
    offsetY: wm.offsetY ?? DEFAULT_WATERMARK.offsetY,
    opacity: wm.opacity ?? DEFAULT_WATERMARK.opacity,
    position: wm.position ?? DEFAULT_WATERMARK.position,
    rotation: wm.rotation ?? DEFAULT_WATERMARK.rotation,
    scale: wm.scale ?? DEFAULT_WATERMARK.scale,
    source: wm.source ?? DEFAULT_WATERMARK.source,
    text: wm.text ?? DEFAULT_WATERMARK.text,
  };
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
  const match = next.match(/^\s*<svg\b[^>]*>([\s\S]*?)<\/svg>\s*$/i);
  return match ? `<g>${match[1]}</g>` : next;
}

export function buildWatermarkSvg(wm: WatermarkSettings, width: number, height: number): string {
  const normalized = normalizeWatermark(wm);
  const pos = watermarkAnchor(normalized.position, width, height);
  const x = pos.x;
  const y = pos.y;
  const transform = transformFor(normalized, x, y);
  const opacity = Math.max(0, Math.min(1, normalized.opacity));

  const body =
    normalized.kind === "svg" && normalized.svgMarkup
      ? overrideImportedSvg(normalized.svgMarkup, normalized)
      : `<text x="${x}" y="${y}" dy="${pos.dy}" text-anchor="${pos.textAnchor}" dominant-baseline="${pos.dominantBaseline}" font-family="${escapeXml(normalized.fontFamily)}" font-size="${normalized.fontSize}" font-weight="${normalized.bold ? 700 : 400}" font-style="${normalized.italic ? "italic" : "normal"}" fill="${normalized.color}">${escapeXml(normalized.text)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g opacity="${opacity}" transform="${transform}">${body}</g></svg>`;
}

export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

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

export function watermarkAnchor(position: WatermarkPosition, width: number, height: number, padding = PADDING) {
  const pad = padding;
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
    padding: wm.padding ?? DEFAULT_WATERMARK.padding ?? PADDING,
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
  const pos = watermarkAnchor(normalized.position, width, height, normalized.padding);
  const x = pos.x;
  const y = pos.y;
  const skewY = y + pos.dy;
  const transform = transformFor(normalized, x, y);
  const opacity = Math.max(0, Math.min(1, normalized.opacity));
  const italicDegree = Math.max(0, normalized.italicDegree ?? 0);

  const textBody = `<text x="${x}" y="${y}" dy="${pos.dy}" text-anchor="${pos.textAnchor}" dominant-baseline="${pos.dominantBaseline}" font-family="${escapeXml(normalized.fontFamily)}" font-size="${normalized.fontSize}" font-weight="${normalized.bold ? 700 : 400}" font-style="${normalized.italic ? "italic" : "normal"}" fill="${normalized.color}">${escapeXml(normalized.text)}</text>`;
  const body =
    normalized.kind === "svg" && normalized.svgMarkup
      ? overrideImportedSvg(normalized.svgMarkup, normalized)
      : italicDegree > 0
        ? `<g transform="translate(${x} ${skewY}) skewX(${-italicDegree}) translate(${-x} ${-skewY})">${textBody}</g>`
        : textBody;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g opacity="${opacity}" transform="${transform}">${body}</g></svg>`;
}

export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function scaleWatermarkForExport(
  wm: WatermarkSettings,
  exportWidth: number,
  exportHeight: number,
): WatermarkSettings {
  const previewWidth = wm.previewWidth && wm.previewWidth > 0 ? wm.previewWidth : exportWidth;
  const previewHeight = wm.previewHeight && wm.previewHeight > 0 ? wm.previewHeight : exportHeight;
  const exportScale = (exportWidth / previewWidth + exportHeight / previewHeight) / 2;

  return {
    ...wm,
    fontSize: wm.fontSize * exportScale,
    offsetX: wm.offsetX * exportScale,
    offsetY: wm.offsetY * exportScale,
    shadowBlur: wm.shadowBlur * exportScale,
    shadowOffsetX: wm.shadowOffsetX * exportScale,
    shadowOffsetY: wm.shadowOffsetY * exportScale,
    strokeWidth: wm.strokeWidth * exportScale,
    padding: (wm.padding ?? PADDING) * exportScale,
  };
}

export async function renderWatermarkPngBytes(
  wm: WatermarkSettings,
  exportWidth: number,
  exportHeight: number,
): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = exportWidth;
  canvas.height = exportHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("watermark canvas context unavailable");

  const scaled = scaleWatermarkForExport(wm, exportWidth, exportHeight);
  const svg = buildWatermarkSvg(scaled, exportWidth, exportHeight);
  const image = new Image();
  image.decoding = "sync";
  image.src = svgToDataUrl(svg);
  await image.decode();
  ctx.clearRect(0, 0, exportWidth, exportHeight);
  ctx.drawImage(image, 0, 0, exportWidth, exportHeight);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((next) => {
      if (next) resolve(next);
      else reject(new Error("watermark png encode failed"));
    }, "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

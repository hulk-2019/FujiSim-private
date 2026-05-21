import type { WatermarkSettings, WatermarkPosition } from "@/types";

const PADDING = 16;

function quoteFontFamily(family: string): string {
  return family
    .split(",")
    .map((f) => {
      const trimmed = f.trim();
      if (/^["'].*["']$/.test(trimmed)) return trimmed;
      if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(trimmed)) return trimmed;
      return `"${trimmed}"`;
    })
    .join(", ");
}

type AnchorXY = { ax: number; ay: number };

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** hex + alpha → rgba()，用于把 opacity 预乘进颜色，避免 alpha 被双重应用 */
function colorWithAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha.toFixed(4)})`;
}

/** 根据水印位置和文字尺寸计算绘制起点 */
function resolveAnchor(
  position: WatermarkPosition,
  tw: number,
  th: number,
  canvasW: number,
  canvasH: number,
  padding: number,
  offX: number,
  offY: number,
): AnchorXY {
  const cx = (canvasW - tw) / 2;
  const cy = (canvasH - th) / 2;
  const r = canvasW - padding - tw;
  const b = canvasH - padding - th;
  switch (position) {
    case "top-left":     return { ax: padding + offX,  ay: padding + offY };
    case "top-center":   return { ax: cx + offX,       ay: padding + offY };
    case "top-right":    return { ax: r + offX,        ay: padding + offY };
    case "bottom-left":  return { ax: padding + offX,  ay: b + offY };
    case "bottom-center":return { ax: cx + offX,       ay: b + offY };
    case "bottom-right": return { ax: r + offX,        ay: b + offY };
    case "left-center":  return { ax: padding + offX,  ay: cy + offY };
    case "right-center": return { ax: r + offX,        ay: cy + offY };
    default:             return { ax: cx + offX,       ay: cy + offY };
  }
}

export async function renderWatermarkLayer(
  wm: WatermarkSettings,
  baseW: number,
  baseH: number,
  scale: number = 1,
): Promise<{ data: string; width: number; height: number }> {
  const canvasW = Math.round(baseW * scale);
  const canvasH = Math.round(baseH * scale);

  // 离屏 canvas：把 opacity 预乘进文字色和阴影色，以 alpha=1 绘制
  // 避免 drawImage(globalAlpha) 时对已有 alpha 的像素二次乘法导致颜色偏重
  const offscreen = document.createElement("canvas");
  offscreen.width = canvasW;
  offscreen.height = canvasH;
  const octx = offscreen.getContext("2d")!;

  octx.clearRect(0, 0, canvasW, canvasH);
  const fontSpec = `${wm.bold ? "bold " : ""}${wm.fontSize * scale}px ${quoteFontFamily(wm.fontFamily)}`;
  // 确保字体已加载，否则 canvas 会静默回退到默认字体
  await document.fonts.load(fontSpec);
  octx.font = fontSpec;
  // 文字颜色预乘 opacity
  octx.fillStyle = colorWithAlpha(wm.color, wm.opacity);

  const metrics = octx.measureText(wm.text);
  const tw = metrics.width;
  const th =
    metrics.actualBoundingBoxAscent !== undefined
      ? metrics.actualBoundingBoxAscent + (metrics.actualBoundingBoxDescent ?? 0)
      : wm.fontSize * scale;

  const padding = PADDING * scale;
  const { ax, ay } = resolveAnchor(
    wm.position,
    tw, th,
    canvasW, canvasH,
    padding,
    wm.offsetX * scale,
    wm.offsetY * scale,
  );

  const cx = ax + tw / 2;
  const cy = ay + th / 2;
  octx.save();
  octx.translate(cx, cy);
  if (wm.rotation !== 0) octx.rotate((wm.rotation * Math.PI) / 180);
  octx.scale(wm.flipH ? -1 : 1, wm.flipV ? -1 : 1);
  if (wm.italic) octx.transform(1, 0, Math.tan((-wm.italicDegree * Math.PI) / 180), 1, 0, 0);
  octx.translate(-cx, -cy);

  const baseline =
    metrics.actualBoundingBoxAscent !== undefined
      ? metrics.actualBoundingBoxAscent
      : wm.fontSize * scale * 0.8;

  if (wm.shadowEnabled) {
    octx.shadowColor = colorWithAlpha(wm.shadowColor, wm.opacity);
    octx.shadowBlur = (wm.shadowBlur / 2) * scale;
    octx.shadowOffsetX = wm.shadowOffsetX * scale;
    octx.shadowOffsetY = wm.shadowOffsetY * scale;
  }
  octx.fillText(wm.text, ax, ay + baseline);

  if (wm.strokeEnabled) {
    octx.shadowColor = "transparent";
    octx.shadowBlur = 0;
    octx.shadowOffsetX = 0;
    octx.shadowOffsetY = 0;
    octx.strokeStyle = colorWithAlpha(wm.strokeColor, wm.opacity);
    octx.lineWidth = wm.strokeWidth * scale;
    octx.lineJoin = "round";
    octx.strokeText(wm.text, ax, ay + baseline);
  }
  octx.restore();

  // 主 canvas：直接 drawImage，不再需要 globalAlpha（opacity 已预乘进颜色）
  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(offscreen, 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve({
          data: (reader.result as string).split(",")[1],
          width: canvasW,
          height: canvasH,
        });
      };
      reader.readAsDataURL(blob!);
    }, "image/png");
  });
}

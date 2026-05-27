import type { HistogramData } from "@/types";

export const ANIM_DURATION_MS = 180;

export type HistFrame = { r: number[]; g: number[]; b: number[]; luma: number[] };

export function makeZeros(): HistFrame {
  return {
    r: new Array(256).fill(0),
    g: new Array(256).fill(0),
    b: new Array(256).fill(0),
    luma: new Array(256).fill(0),
  };
}

export function cloneFrame(f: HistFrame): HistFrame {
  return {
    r: f.r.slice(),
    g: f.g.slice(),
    b: f.b.slice(),
    luma: f.luma.slice(),
  };
}

export function sqrtify(data: HistogramData): HistFrame {
  return {
    r: data.r.map((v) => Math.sqrt(v)),
    g: data.g.map((v) => Math.sqrt(v)),
    b: data.b.map((v) => Math.sqrt(v)),
    luma: data.luma.map((v) => Math.sqrt(v)),
  };
}

export function lerpFrame(from: HistFrame, target: HistFrame, eased: number): HistFrame {
  const lerp = (a: number[], b: number[]) =>
    a.map((v, i) => v + (b[i] - v) * eased);
  return {
    r: lerp(from.r, target.r),
    g: lerp(from.g, target.g),
    b: lerp(from.b, target.b),
    luma: lerp(from.luma, target.luma),
  };
}

export function drawHistogram(
  canvas: HTMLCanvasElement,
  container: HTMLDivElement,
  displayed: HistFrame | null,
  height: number,
  enabled: { r: boolean; g: boolean; b: boolean; luma: boolean },
) {
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth;
  const h = height;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Background
  ctx.fillStyle = "rgb(24 24 27)";
  ctx.fillRect(0, 0, w, h);

  if (!displayed) return;

  const { r, g, b, luma } = displayed;
  const bins = 256;

  // RGB max only considers enabled RGB channels
  let rgbMax = 0;
  for (let i = 0; i < bins; i++) {
    if (enabled.r) rgbMax = Math.max(rgbMax, r[i]);
    if (enabled.g) rgbMax = Math.max(rgbMax, g[i]);
    if (enabled.b) rgbMax = Math.max(rgbMax, b[i]);
  }
  // Luma uses its own max — sharing rgbMax would crush luma flat
  // because luma distributions are typically narrower/taller per bin.
  let lumaMax = 0;
  if (enabled.luma) {
    for (let i = 0; i < bins; i++) {
      lumaMax = Math.max(lumaMax, luma[i]);
    }
  }

  if (rgbMax === 0 && lumaMax === 0) return;

  const drawChannel = (channel: number[], maxVal: number, color: string) => {
    if (maxVal === 0) return;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < bins; i++) {
      const x = (i / (bins - 1)) * w;
      const y = h - (channel[i] / maxVal) * (h - 1);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };

  // 1) Luma underneath, source-over (gray fill, no blending)
  ctx.globalCompositeOperation = "source-over";
  if (enabled.luma) drawChannel(luma, lumaMax, "rgba(220,220,220,0.35)");

  // 2) RGB on top with additive blend so overlaps form natural secondaries
  ctx.globalCompositeOperation = "lighter";
  if (enabled.r) drawChannel(r, rgbMax, "rgba(180,40,40,0.65)");
  if (enabled.g) drawChannel(g, rgbMax, "rgba(40,150,40,0.65)");
  if (enabled.b) drawChannel(b, rgbMax, "rgba(40,60,180,0.65)");

  ctx.globalCompositeOperation = "source-over";
}

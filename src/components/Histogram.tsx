import { useRef, useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { HistogramData, Asset } from "@/types";

/** Below this fraction, shadow/highlight clipping is negligible and not flagged. */
const CLIP_THRESHOLD = 0.005;

interface HistogramProps {
  data: HistogramData | null;
  asset?: Asset | null;
  height?: number;
}

function drawHistogram(
  canvas: HTMLCanvasElement,
  container: HTMLDivElement,
  data: HistogramData | null,
  height: number,
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

  if (!data) return;

  const { r, g, b, luma } = data;
  const bins = 256;

  // Apply sqrt compression to each bin to prevent sharp peaks
  // (e.g. highlight clipping) from dominating the display.
  // This matches Lightroom's approach where the y-axis is non-linear.
  const sqrtR = r.map((v) => Math.sqrt(v));
  const sqrtG = g.map((v) => Math.sqrt(v));
  const sqrtB = b.map((v) => Math.sqrt(v));
  const sqrtLuma = luma.map((v) => Math.sqrt(v));

  // Global max for RGB uses the joint max so additive blending stays balanced.
  let rgbMax = 0;
  for (let i = 0; i < bins; i++) {
    rgbMax = Math.max(rgbMax, sqrtR[i], sqrtG[i], sqrtB[i]);
  }
  // Luma uses its own max — sharing rgbMax would crush luma flat
  // because luma distributions are typically narrower/taller per bin.
  let lumaMax = 0;
  for (let i = 0; i < bins; i++) {
    lumaMax = Math.max(lumaMax, sqrtLuma[i]);
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
  drawChannel(sqrtLuma, lumaMax, "rgba(220,220,220,0.35)");

  // 2) RGB on top with additive blend so overlaps form natural secondaries
  ctx.globalCompositeOperation = "lighter";
  drawChannel(sqrtR, rgbMax, "rgba(180,40,40,0.65)");
  drawChannel(sqrtG, rgbMax, "rgba(40,150,40,0.65)");
  drawChannel(sqrtB, rgbMax, "rgba(40,60,180,0.65)");

  ctx.globalCompositeOperation = "source-over";
}

export function Histogram({ data, asset = null, height = 120 }: HistogramProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizeKey, setResizeKey] = useState(0);

  const handleResize = useCallback(() => setResizeKey((k) => k + 1), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    drawHistogram(canvas, container, data, height);
  }, [data, height, resizeKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [handleResize]);

  const clip = computeClip(data);

  return (
    <div className="w-full">
      <div className="flex items-center gap-3 px-2 py-1 text-[10px] text-zinc-400">
        <ChannelDot color="rgb(220,220,220)" label={t("histogram.channels.luma")} />
        <ChannelDot color="rgb(220,80,80)" label={t("histogram.channels.r")} />
        <ChannelDot color="rgb(80,200,80)" label={t("histogram.channels.g")} />
        <ChannelDot color="rgb(100,120,220)" label={t("histogram.channels.b")} />
      </div>
      <div ref={containerRef} className="relative w-full rounded overflow-hidden">
        <canvas ref={canvasRef} />
        {clip.shadow > CLIP_THRESHOLD && (
          <div
            role="img"
            aria-label={t("histogram.shadowClip", { percent: (clip.shadow * 100).toFixed(1) })}
            className="absolute top-1 left-1 w-0 h-0"
            style={{
              borderLeft: "5px solid transparent",
              borderRight: "5px solid transparent",
              borderTop: "6px solid rgb(80,140,255)",
            }}
            title={t("histogram.shadowClip", { percent: (clip.shadow * 100).toFixed(1) })}
          />
        )}
        {clip.highlight > CLIP_THRESHOLD && (
          <div
            role="img"
            aria-label={t("histogram.highlightClip", { percent: (clip.highlight * 100).toFixed(1) })}
            className="absolute top-1 right-1 w-0 h-0"
            style={{
              borderLeft: "5px solid transparent",
              borderRight: "5px solid transparent",
              borderTop: "6px solid rgb(255,90,90)",
            }}
            title={t("histogram.highlightClip", { percent: (clip.highlight * 100).toFixed(1) })}
          />
        )}
      </div>
      <ExifBar asset={asset} />
    </div>
  );
}

function ChannelDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function computeClip(data: HistogramData | null): { shadow: number; highlight: number } {
  if (!data || data.totalPixels === 0) return { shadow: 0, highlight: 0 };
  const total = data.totalPixels * 3;
  const shadow = (data.r[0] + data.g[0] + data.b[0]) / total;
  const highlight = (data.r[255] + data.g[255] + data.b[255]) / total;
  return { shadow, highlight };
}

function ExifBar({ asset }: { asset: Asset | null }) {
  if (!asset) return null;
  const { iso, focal_length, f_number, shutter_speed } = asset;
  const allMissing =
    iso == null && focal_length == null && f_number == null && shutter_speed == null;
  if (allMissing) return null;

  const items = [
    iso != null ? `ISO ${iso}` : "—",
    focal_length != null ? `${focal_length}mm` : "—",
    f_number != null ? `f/${f_number.toFixed(1)}` : "—",
    shutter_speed != null ? `${shutter_speed}s` : "—",
  ];

  return (
    <div className="flex items-center gap-2 px-2 py-1 text-[10px] text-zinc-500">
      {items.map((s, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 && <span className="text-zinc-700">·</span>}
          <span>{s}</span>
        </span>
      ))}
    </div>
  );
}

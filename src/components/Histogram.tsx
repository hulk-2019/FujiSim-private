import { useRef, useEffect, useState, useCallback } from "react";
import type { HistogramData } from "@/types";

interface HistogramProps {
  data: HistogramData | null;
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

  const { r, g, b } = data;
  const bins = 256;

  // Apply sqrt compression to each bin to prevent sharp peaks
  // (e.g. highlight clipping) from dominating the display.
  // This matches Lightroom's approach where the y-axis is non-linear.
  const sqrtR = r.map((v) => Math.sqrt(v));
  const sqrtG = g.map((v) => Math.sqrt(v));
  const sqrtB = b.map((v) => Math.sqrt(v));

  // Global max across compressed channels
  let maxVal = 0;
  for (let i = 0; i < bins; i++) {
    maxVal = Math.max(maxVal, sqrtR[i], sqrtG[i], sqrtB[i]);
  }
  if (maxVal === 0) return;

  // Additive blend so overlapping regions produce natural secondaries
  ctx.globalCompositeOperation = "lighter";

  const drawChannel = (channel: number[], color: string) => {
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

  drawChannel(sqrtR, "rgba(180,40,40,0.65)");
  drawChannel(sqrtG, "rgba(40,150,40,0.65)");
  drawChannel(sqrtB, "rgba(40,60,180,0.65)");

  ctx.globalCompositeOperation = "source-over";
}

export function Histogram({ data, height = 120 }: HistogramProps) {
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

  return (
    <div ref={containerRef} className="w-full rounded overflow-hidden">
      <canvas ref={canvasRef} />
    </div>
  );
}
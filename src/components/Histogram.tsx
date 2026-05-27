import { useRef, useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { HistogramData, Asset } from "@/types";
import {
  ANIM_DURATION_MS,
  cloneFrame,
  drawHistogram,
  lerpFrame,
  makeZeros,
  sqrtify,
  type HistFrame,
} from "@/lib/histogramDraw";

/** Below this fraction, shadow/highlight clipping is negligible and not flagged. */
const CLIP_THRESHOLD = 0.005;

interface HistogramProps {
  data: HistogramData | null;
  asset?: Asset | null;
  height?: number;
}

export function Histogram({ data, asset = null, height = 120 }: HistogramProps) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState({ luma: true, r: true, g: true, b: true });

  const toggleChannel = useCallback(
    (key: "luma" | "r" | "g" | "b") =>
      setEnabled((prev) => ({ ...prev, [key]: !prev[key] })),
    [],
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizeKey, setResizeKey] = useState(0);

  const handleResize = useCallback(() => setResizeKey((k) => k + 1), []);

  // === Animation state machine ===
  const displayedRef = useRef<HistFrame | null>(null);
  const targetRef = useRef<HistFrame | null>(null);
  const animFromRef = useRef<HistFrame | null>(null);
  const animStartRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    drawHistogram(canvas, container, displayedRef.current, height, enabled);
  }, [enabled, height]);

  // Start or continue the animation loop. No-op if already running.
  const ensureRaf = useCallback(() => {
    if (rafRef.current != null) return;
    const tick = (now: number) => {
      const from = animFromRef.current;
      const target = targetRef.current;
      if (!from || !target) {
        rafRef.current = null;
        return;
      }
      const t = Math.min(1, (now - animStartRef.current) / ANIM_DURATION_MS);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      displayedRef.current = lerpFrame(from, target, eased);
      redraw();
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        displayedRef.current = target;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [redraw]);

  // Data updates: snapshot current displayed as `from`, set new target, kick RAF.
  useEffect(() => {
    if (!data) {
      targetRef.current = null;
      displayedRef.current = null;
      animFromRef.current = null;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      redraw();
      return;
    }
    const newTarget = sqrtify(data);
    animFromRef.current = displayedRef.current
      ? cloneFrame(displayedRef.current)
      : makeZeros();
    targetRef.current = newTarget;
    animStartRef.current = performance.now();
    ensureRaf();
  }, [data, redraw, ensureRaf]);

  // Enabled toggle / resize: just redraw with current displayed frame, no animation.
  useEffect(() => {
    redraw();
  }, [enabled, resizeKey, redraw]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

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
      <div className="flex items-center gap-3 px-2 py-1 text-[10px]">
        <ChannelDot
          color="rgb(220,220,220)"
          label={t("histogram.channels.luma")}
          enabled={enabled.luma}
          onToggle={() => toggleChannel("luma")}
        />
        <ChannelDot
          color="rgb(220,80,80)"
          label={t("histogram.channels.r")}
          enabled={enabled.r}
          onToggle={() => toggleChannel("r")}
        />
        <ChannelDot
          color="rgb(80,200,80)"
          label={t("histogram.channels.g")}
          enabled={enabled.g}
          onToggle={() => toggleChannel("g")}
        />
        <ChannelDot
          color="rgb(100,120,220)"
          label={t("histogram.channels.b")}
          enabled={enabled.b}
          onToggle={() => toggleChannel("b")}
        />
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

function ChannelDot({
  color,
  label,
  enabled,
  onToggle,
}: {
  color: string;
  label: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      className={`inline-flex items-center gap-1 border-0 bg-transparent p-0 cursor-pointer transition-opacity ${
        enabled ? "text-zinc-300" : "text-zinc-600"
      }`}
    >
      <span
        className="inline-block w-2 h-2 rounded-full transition-opacity"
        style={{ backgroundColor: color, opacity: enabled ? 1 : 0.3 }}
      />
      {label}
    </button>
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

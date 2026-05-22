import { useEffect, useRef, useState } from "react";
import type { CurvePoint, ToneCurvePoints } from "@/types";
import { CanvasSpliner } from "./CanvasSpliner";

type Channel = "rgb" | "r" | "g" | "b";

const CHANNEL_COLOR: Record<Channel, string> = {
  rgb: "rgba(60, 60, 60, 1)",
  r: "rgba(210, 50, 50, 1)",
  g: "rgba(30, 150, 50, 1)",
  b: "rgba(40, 90, 210, 1)",
};

const DEFAULT_POINTS: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

function pointsToNormalized(pts: CurvePoint[]): CurvePoint[] {
  return pts.length === 0 ? DEFAULT_POINTS : pts;
}

function buildSpliner(
  container: HTMLElement,
  size: number,
  channel: Channel,
  pts: CurvePoint[]
): CanvasSpliner {
  const spliner = new CanvasSpliner(container, size, size, "monotonic");
  spliner.setBackgroundColor("#f0f0f0");
  spliner.setGridColor("rgba(0,0,0,0.06)");
  spliner.setGridStep(0.25);
  spliner.setCurveColor("idle", CHANNEL_COLOR[channel]);
  spliner.setCurveColor("moving", CHANNEL_COLOR[channel]);
  spliner.setControlPointColor("idle", CHANNEL_COLOR[channel].replace("1)", "0.5)"));
  spliner.setControlPointColor("hovered", CHANNEL_COLOR[channel].replace("1)", "0.85)"));
  spliner.setControlPointColor("grabbed", CHANNEL_COLOR[channel]);
  spliner.setControlPointRadius(4);
  spliner.setCurveThickness(1.5);

  // Sort by x so first/last are unambiguously the endpoints
  const sorted = [...pts].sort((a, b) => a.x - b.x);
  for (let i = 0; i < sorted.length; i++) {
    const pt = sorted[i];
    const isFirst = i === 0;
    const isLast = i === sorted.length - 1;
    const isEndpoint = isFirst || isLast;
    // BL endpoint anchored at (0, 0) — only moves along x=0 (left edge) or y=0 (bottom edge)
    // TR endpoint anchored at (1, 1) — only moves along x=1 (right edge) or y=1 (top edge)
    const anchor = isFirst ? { x: 0, y: 0 } : isLast ? { x: 1, y: 1 } : undefined;
    spliner.add({
      x: pt.x,
      y: pt.y,
      xLocked: false,
      safe: isEndpoint,
      axisLocked: isEndpoint,
      anchor,
    }, false);
  }
  spliner.draw();
  return spliner;
}

function commitPoints(s: CanvasSpliner): CurvePoint[] {
  // Store the actual user control points, not a resampled interpolation
  return s.getControlPoints();
}

export function CurvesEditor({
  value,
  onChange,
}: {
  value: ToneCurvePoints | null | undefined;
  onChange: (v: ToneCurvePoints) => void;
}) {
  const [activeChannel, setActiveChannel] = useState<Channel>("rgb");
  const containerRef = useRef<HTMLDivElement>(null);
  const splinerRef = useRef<CanvasSpliner | null>(null);
  const valueRef = useRef(value);
  const channelRef = useRef(activeChannel);
  const onChangeRef = useRef(onChange);

  useEffect(() => { valueRef.current = value; }, [value]);
  useEffect(() => { channelRef.current = activeChannel; }, [activeChannel]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Self-healing: redraw on every React render. Cheap (single canvas op),
  // and guarantees the canvas content is in sync regardless of cause —
  // backing-store eviction, HMR, layout collapse, etc.
  useEffect(() => {
    const s = splinerRef.current;
    const container = containerRef.current;
    if (s && container) {
      const canvas = (s as any)._canvas as HTMLCanvasElement | null;
      if (canvas && !container.contains(canvas)) {
        console.warn("[CurvesEditor] canvas detached — re-attaching");
        container.appendChild(canvas);
      }
      s.draw();
    }
  });

  // Build spliner once container size is known, rebuild on channel change
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let spliner: CanvasSpliner | null = null;
    // Effect-local size — guarantees a fresh effect always initializes,
    // even if a previous effect (e.g. from StrictMode remount) wrote sizeRef.
    let currentSize = 0;

    function init(size: number) {
      console.log("[CurvesEditor] init", {
        size,
        prevSize: currentSize,
        channel: channelRef.current,
        hadSpliner: !!spliner,
      });
      if (spliner) { spliner.destroy(); spliner = null; }
      currentSize = size;

      const pts = pointsToNormalized(valueRef.current?.[channelRef.current] ?? []);
      spliner = buildSpliner(container!, size, channelRef.current, pts);
      splinerRef.current = spliner;

      const commit = (s: CanvasSpliner) => {
        const newPts = commitPoints(s);
        const cur = valueRef.current ?? { rgb: [], r: [], g: [], b: [] };
        const isIdentity =
          newPts.length === 2 &&
          newPts[0].x === 0 && newPts[0].y === 0 &&
          newPts[1].x === 1 && newPts[1].y === 1;
        // Validate before committing — anything weird gets logged
        const invalid = newPts.some(
          (p) => !isFinite(p.x) || !isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1
        );
        if (invalid) {
          console.error("[CurvesEditor] commit aborted: invalid points", newPts);
          return;
        }
        console.log("[CurvesEditor] commit", { channel: channelRef.current, newPts, isIdentity });
        onChangeRef.current({ ...cur, [channelRef.current]: isIdentity ? [] : newPts });
      };

      spliner.on("releasePoint", commit);
      spliner.on("pointAdded", commit);
      spliner.on("pointRemoved", commit);
    }

    // Use ResizeObserver to get actual CSS pixel size
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const size = Math.round(entry.contentRect.width);
      // Only rebuild on significant size change (>2px). Sub-pixel jitter during
      // a drag would otherwise destroy/recreate the spliner mid-interaction.
      if (size > 0 && Math.abs(size - currentSize) > 2) {
        console.log("[CurvesEditor] ResizeObserver triggers init", {
          size,
          prevSize: currentSize,
          diff: size - currentSize,
        });
        init(size);
      }
    });
    ro.observe(container);

    // Fallback: init immediately if already sized
    const initialSize = Math.round(container.getBoundingClientRect().width);
    if (initialSize > 0) init(initialSize);

    // Browser may discard canvas backing store on visibility/focus changes
    // (especially on macOS with battery saver). Force a redraw when we're
    // shown again so the curve doesn't appear blank.
    const redraw = () => splinerRef.current?.draw();
    document.addEventListener("visibilitychange", redraw);
    window.addEventListener("focus", redraw);

    return () => {
      ro.disconnect();
      document.removeEventListener("visibilitychange", redraw);
      window.removeEventListener("focus", redraw);
      if (spliner) { spliner.destroy(); spliner = null; }
      splinerRef.current = null;
    };
  }, [activeChannel]);

  function handleReset() {
    const cur = valueRef.current ?? { rgb: [], r: [], g: [], b: [] };
    onChangeRef.current({ ...cur, [activeChannel]: [] });
    if (splinerRef.current) {
      splinerRef.current.resetPoints([
        { x: 0, y: 0, xLocked: false, safe: true, axisLocked: true, anchor: { x: 0, y: 0 } },
        { x: 1, y: 1, xLocked: false, safe: true, axisLocked: true, anchor: { x: 1, y: 1 } },
      ]);
    }
  }

  const channels: Channel[] = ["rgb", "r", "g", "b"];
  const channelLabels: Record<Channel, string> = { rgb: "RGB", r: "R", g: "G", b: "B" };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {channels.map((ch) => (
            <button
              key={ch}
              type="button"
              onClick={() => setActiveChannel(ch)}
              className="px-2 py-0.5 text-[10px] rounded font-semibold transition-colors"
              style={{
                color: activeChannel === ch ? CHANNEL_COLOR[ch] : "#71717a",
                background: activeChannel === ch ? "rgba(0,0,0,0.06)" : "transparent",
              }}
            >
              {channelLabels[ch]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={handleReset}
          className="text-[10px] text-zinc-500 hover:text-zinc-700 transition-colors px-1"
        >
          重置
        </button>
      </div>

      <div
        key={activeChannel}
        ref={containerRef}
        className="w-full rounded overflow-hidden"
        style={{ aspectRatio: "1 / 1" }}
      />

      <p className="text-[10px] text-zinc-400 leading-none">
        双击添加/删除节点 · 拖拽移动 · 按 D 删除悬停节点
      </p>
    </div>
  );
}

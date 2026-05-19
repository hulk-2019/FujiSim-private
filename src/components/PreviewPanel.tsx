import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon, Eye, EyeOff } from "lucide-react";
import { api } from "@/api";
import type { WatermarkSettings } from "@/types";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/utils";
import { useTranslation } from "react-i18next";

export function PreviewPanel({ onExport }: { onExport: () => void }) {
  const { t } = useTranslation();
  const focusedId = useStore((s) => s.focusedId);
  const assets = useStore((s) => s.assets);
  const filter = useStore((s) => s.filter);
  const watermark = useStore((s) => s.watermark);
  const setPreviewSize = useStore((s) => s.setPreviewSize);
  const setPreviewContainerSize = useStore((s) => s.setPreviewContainerSize);
  const previewContainerSize = useStore((s) => s.previewContainerSize);
  const focused = assets.find((a) => a?.id === focusedId) ?? null;
  const rawThumbnailReady = useStore((s) => s.rawThumbnailReady);
  const thumbnailDir = useStore((s) => s.thumbnailDir);

  const [preview, setPreview] = useState<{ blobUrl: string; width: number; height: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [thumbSrc, setThumbSrc] = useState<string | null>(null);
  const reqId = useRef(0);
  const previewCache = useRef<Map<string, { blobUrl: string; width: number; height: number }>>(new Map());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  const containerCallbackRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    containerRef.current = el;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      requestAnimationFrame(() => {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0)
          setPreviewContainerSize({ width: Math.round(width), height: Math.round(height) });
      });
    });
    ro.observe(el);
    roRef.current = ro;
  }, []);

  // 组件卸载时断开 ResizeObserver（本地文件路径无需 revokeObjectURL）
  useEffect(() => {
    return () => {
      roRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!focused) {
      setThumbSrc(null);
      return;
    }
    if (focused.is_raw) {
      // 优先用 thumbnailDir 拼接路径（rawThumbnailReady 标记已生成）
      if (rawThumbnailReady.has(focused.id) && thumbnailDir) {
        try {
          setThumbSrc(convertFileSrc(`${thumbnailDir}/${focused.id}.jpg`));
        } catch {
          setThumbSrc(null);
        }
      } else {
        // 懒加载：立刻请求，无 debounce（缩略图应尽快显示）
        let cancelled = false;
        setThumbSrc(null);
        api.getRawThumbnail(focused.id)
          .then((path) => {
            if (cancelled) return;
            try { setThumbSrc(convertFileSrc(path)); } catch { setThumbSrc(null); }
          })
          .catch(() => { if (!cancelled) setThumbSrc(null); });
        return () => { cancelled = true; };
      }
    } else {
      try {
        setThumbSrc(convertFileSrc(focused.file_path));
      } catch {
        setThumbSrc(null);
      }
    }
  }, [focused?.id, focused?.file_path, focused?.is_raw, rawThumbnailReady, thumbnailDir]);

  useEffect(() => {
    if (!focused) {
      setPreview(null);
      setLoading(false);
      return;
    }
    const filterKey = JSON.stringify(filter);
    const cacheKey = `${focused.id}:${filterKey}`;
    // 命中前端缓存：直接恢复结果，零后端调用
    const cached = previewCache.current.get(cacheKey);
    if (cached) {
      setPreview(cached);
      setPreviewSize({ width: cached.width, height: cached.height }, focused.id);
      setLoading(false);
      return;
    }
    // Clear stale full preview immediately so we fall back to thumbSrc
    setPreview(null);
    setError(null);
    const myId = ++reqId.current;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const r = await api.getPreview(focused.id, filter, 1280);
        if (reqId.current === myId) {
          const src = convertFileSrc(r.path);
          const entry = { blobUrl: src, width: r.width, height: r.height };
          previewCache.current.set(cacheKey, entry);
          setPreview(entry);
          setPreviewSize({ width: r.width, height: r.height }, focused.id);
          setLoading(false);
        }
      } catch (e) {
        if (reqId.current === myId) {
          setError(String(e));
          setLoading(false);
        }
      }
    }, 150);
    return () => clearTimeout(handle);
  }, [focused?.id, filter]);

  async function handleShowOriginal() {
    setShowOriginal(true);
    if (focused?.is_raw && !(rawThumbnailReady.has(focused.id) && thumbnailDir)) {
      try {
        await api.getRawThumbnail(focused.id);
      } catch {
        // 静默失败
      }
    }
  }

  if (!focused) {
    return (
      <main className="w-full h-full flex items-center justify-center text-zinc-600 bg-transparent">
        <div className="flex flex-col items-center gap-2 text-sm">
          <ImageIcon size={40} />
          <span>{t("previewPanel.selectPhoto")}</span>
        </div>
      </main>
    );
  }

  const previewSrc = preview?.blobUrl ?? null;
  // originalSrc 用 thumbSrc（懒加载后已确认文件存在），非 RAW 直接用原文件
  const originalSrc = focused.is_raw
    ? thumbSrc
    : convertFileSrc(focused.file_path);

  return (
    <main className="w-full h-full flex flex-col bg-transparent min-w-0">
      <div className="border-b border-zinc-800/60 px-4 py-2 flex items-center gap-3 text-xs bg-zinc-950/40">
        <div className="flex-1 min-w-0">
          <p className="text-zinc-100 truncate text-sm">{focused.file_name}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onMouseDown={handleShowOriginal}
          onMouseUp={() => setShowOriginal(false)}
          onMouseLeave={() => setShowOriginal(false)}
        >
          {showOriginal ? <EyeOff size={12} /> : <Eye size={12} />} {t("previewPanel.holdToCompare")}
        </Button>
        <Button onClick={onExport} size="sm">
          {t("previewPanel.export")}
        </Button>
      </div>
      <div className="flex-1 relative overflow-hidden flex items-center justify-center p-4 bg-zinc-950/20">
        {error ? (
          <div className="text-zinc-400 text-sm bg-zinc-900/80 px-4 py-2 rounded border border-zinc-800">
            {error}
          </div>
        ) : (
          <>
            {showOriginal && originalSrc && (
              <img
                src={originalSrc}
                alt="original"
                className="max-w-full max-h-full object-contain shadow-2xl no-drag"
              />
            )}
            {!showOriginal && (previewSrc ?? thumbSrc) && (
              <div
                ref={containerCallbackRef}
                className="relative max-w-full max-h-full shadow-2xl"
                style={
                  preview
                    ? { aspectRatio: `${preview.width} / ${preview.height}` }
                    : focused?.width && focused?.height
                    ? { aspectRatio: `${focused.width} / ${focused.height}` }
                    : undefined
                }
              >
                <img
                  src={(previewSrc ?? thumbSrc)!}
                  alt="preview"
                  className="w-full h-full object-contain no-drag"
                />
                {watermark.enabled && preview && previewContainerSize && (
                  <WatermarkOverlay
                    wm={watermark}
                    previewW={preview.width}
                    previewH={preview.height}
                    containerW={previewContainerSize.width}
                  />
                )}
              </div>
            )}
            {/* 无图可显示时的占位：loading 期间或图片尚未就绪 */}
            {!showOriginal && !(previewSrc ?? thumbSrc) && (
              <div className="flex flex-col items-center justify-center gap-3 text-zinc-600">
                {loading ? (
                  <>
                    <svg className="animate-spin w-8 h-8 text-zinc-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                    <span className="text-xs text-zinc-500">{t("previewPanel.rendering")}</span>
                  </>
                ) : (
                  <ImageIcon size={40} className="text-zinc-700" />
                )}
              </div>
            )}
            {loading && (previewSrc ?? thumbSrc) && (
              <div className="absolute top-3 left-3 text-xs text-zinc-400 bg-zinc-950/60 px-2 py-1 rounded">
                {t("previewPanel.rendering")}
              </div>
            )}
            {preview && (
              <div className="absolute bottom-3 right-3 text-[10px] text-zinc-500 bg-zinc-950/60 px-2 py-1 rounded">
                {focused.width ?? preview.width} × {focused.height ?? preview.height} · {formatBytes(focused.file_size)}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

const PADDING = 16;

function buildTransform(wm: WatermarkSettings, baseTranslate: string): string {
  const parts: string[] = [baseTranslate];
  if (wm.rotation !== 0) parts.push(`rotate(${wm.rotation}deg)`);
  if (wm.flipH || wm.flipV) parts.push(`scale(${wm.flipH ? -1 : 1}, ${wm.flipV ? -1 : 1})`);
  if (wm.italic) parts.push(`skewX(${-wm.italicDegree}deg)`);
  return parts.join(" ");
}

function resolvePositionStyle(wm: WatermarkSettings): React.CSSProperties {
  const { position, offsetX: ox, offsetY: oy } = wm;
  const p = PADDING;
  const t = (base: string) => buildTransform(wm, base);
  switch (position) {
    case "top-left":     return { top: p + oy,  left: p + ox,                          transform: t("") };
    case "top-center":   return { top: p + oy,  left: `calc(50% + ${ox}px)`,           transform: t("translateX(-50%)") };
    case "top-right":    return { top: p + oy,  right: p - ox,                         transform: t("") };
    case "bottom-left":  return { bottom: p - oy, left: p + ox,                        transform: t("") };
    case "bottom-center":return { bottom: p - oy, left: `calc(50% + ${ox}px)`,         transform: t("translateX(-50%)") };
    case "bottom-right": return { bottom: p - oy, right: p - ox,                       transform: t("") };
    case "left-center":  return { left: p + ox,  top: `calc(50% + ${oy}px)`,           transform: t("translateY(-50%)") };
    case "right-center": return { right: p - ox, top: `calc(50% + ${oy}px)`,           transform: t("translateY(-50%)") };
    default:             return { top: `calc(50% + ${oy}px)`, left: `calc(50% + ${ox}px)`, transform: t("translate(-50%, -50%)") };
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(4)})`;
}

function WatermarkOverlay({
  wm,
  previewW,
  previewH,
  containerW,
}: {
  wm: WatermarkSettings;
  previewW: number;
  previewH: number;
  containerW: number;
}) {
  const shadow = wm.shadowEnabled
    ? `${wm.shadowOffsetX}px ${wm.shadowOffsetY}px ${wm.shadowBlur}px ${hexToRgba(wm.shadowColor, wm.opacity)}`
    : undefined;

  const posStyle = resolvePositionStyle(wm);

  const scale = containerW > 0 && previewW > 0 ? containerW / previewW : 1;

  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: previewW, height: previewH, transformOrigin: "top left", transform: `scale(${scale})`, pointerEvents: "none" }}>
      <div style={{ position: "absolute", ...posStyle, fontFamily: wm.fontFamily, fontSize: wm.fontSize, fontWeight: wm.bold ? "bold" : "normal", color: hexToRgba(wm.color, wm.opacity), textShadow: shadow, whiteSpace: "nowrap", lineHeight: 1, userSelect: "none", WebkitTextStroke: wm.strokeEnabled ? `${wm.strokeWidth}px ${hexToRgba(wm.strokeColor, wm.opacity)}` : undefined, paintOrder: wm.strokeEnabled ? "fill stroke" : undefined }}>
        {wm.text}
      </div>
    </div>
  );
}

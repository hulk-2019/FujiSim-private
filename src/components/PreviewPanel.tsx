import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon, Eye, EyeOff } from "lucide-react";
import { api } from "@/api";
import type { WatermarkSettings } from "@/types";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/utils";
import { useTranslation } from "react-i18next";

// 全局单调递增 token，每次发起新预览请求时递增，后端用它识别过期请求
let previewTokenCounter = 0;

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

  const [preview, setPreview] = useState<{ blobUrl: string; width: number; height: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [rawOriginalSrc, setRawOriginalSrc] = useState<string | null>(null);
  // 当前请求的 token，用于在回调中判断结果是否仍然有效
  const currentTokenRef = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  const containerCallbackRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    containerRef.current = el;
    if (!el) return;
    let rafId = 0;
    const ro = new ResizeObserver((entries) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0)
          setPreviewContainerSize({ width: Math.round(width), height: Math.round(height) });
      });
    });
    ro.observe(el);
    roRef.current = ro;
  }, []);

  useEffect(() => {
    return () => { roRef.current?.disconnect(); };
  }, []);

  useEffect(() => {
    if (!focused) {
      setPreview(null);
      setLoading(false);
      setRawOriginalSrc(null);
      return;
    }

    const token = ++previewTokenCounter;
    currentTokenRef.current = token;

    setPreview(null);
    setError(null);
    setRawOriginalSrc(null);
    setLoading(true);

    const handle = setTimeout(async () => {
      // Step 1: RAW 嵌入原图（仅 RAW 文件，缓存命中时几乎无延迟）
      if (focused.is_raw) {
        try {
          const path = await api.getRawOriginal(focused.id, token);
          if (currentTokenRef.current === token) {
            setRawOriginalSrc(convertFileSrc(path));
          }
        } catch (e) {
          if (String(e).includes("preview_cancelled")) return;
          // 其他错误忽略，继续加载 preview
        }
      }

      if (currentTokenRef.current !== token) return;

      // Step 2: 实时预览
      const doPreview = async () => {
        const r = await api.getPreview(focused.id, filter, 1280, token);
        if (currentTokenRef.current !== token) return;
        const src = convertFileSrc(r.path);
        setPreview({ blobUrl: src, width: r.width, height: r.height });
        setPreviewSize({ width: r.width, height: r.height }, focused.id);
        setLoading(false);
      };

      try {
        await doPreview();
      } catch (e) {
        if (currentTokenRef.current !== token) return;
        if (String(e).includes("preview_cancelled")) return;
        if (String(e).includes("preview_busy")) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (currentTokenRef.current !== token) return;
          try {
            await doPreview();
          } catch (e2) {
            if (currentTokenRef.current === token && !String(e2).includes("preview_cancelled")) {
              setError(String(e2));
              setLoading(false);
            }
          }
        } else {
          setError(String(e));
          setLoading(false);
        }
      }
    }, 250);

    return () => clearTimeout(handle);
  }, [focused?.id, focused?.is_raw, filter]);

  function handleShowOriginal() {
    setShowOriginal(true);
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
  // originalSrc：RAW 用完整嵌入 JPEG（后台已异步加载），非 RAW 用原文件
  const originalSrc = focused.is_raw
    ? rawOriginalSrc
    : convertFileSrc(focused.file_path);

  // 占位图优先级：rawOriginalSrc > DB 缓存的 preview_path > cover_path > 非 RAW 原文件
  const placeholderSrc: string | null = (() => {
    if (rawOriginalSrc) return rawOriginalSrc;
    if (focused.is_raw) {
      if (focused.preview_path) {
        try { return convertFileSrc(focused.preview_path); } catch { /* ignore */ }
      }
      if (focused.cover_path) {
        try { return convertFileSrc(focused.cover_path); } catch { /* ignore */ }
      }
      return null;
    }
    try { return convertFileSrc(focused.file_path); } catch { return null; }
  })();

  const displaySrc = previewSrc ?? placeholderSrc;

  // 宽高比：优先用 DB 存储的原始尺寸，没有时用 3/2 作为合理默认值，避免骨架屏全屏
  const aspectRatio = focused.width && focused.height
    ? `${focused.width} / ${focused.height}`
    : preview
    ? `${preview.width} / ${preview.height}`
    : "3 / 2";

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
            {(displaySrc || originalSrc) ? (
              <div
                ref={containerCallbackRef}
                className="relative max-w-full max-h-full shadow-2xl"
                style={{ aspectRatio: aspectRatio ?? undefined, width: "100%", height: "100%" }}
              >
                {displaySrc && (
                  <img
                    src={displaySrc}
                    alt="preview"
                    className="absolute inset-0 w-full h-full object-contain no-drag"
                    style={{ opacity: showOriginal ? 0 : 1 }}
                  />
                )}
                {originalSrc && (
                  <img
                    src={originalSrc}
                    alt="original"
                    className="absolute inset-0 w-full h-full object-contain no-drag"
                    style={{ opacity: showOriginal ? 1 : 0 }}
                  />
                )}
                {!showOriginal && watermark.enabled && preview && previewContainerSize && (
                  <WatermarkOverlay
                    wm={watermark}
                    previewW={preview.width}
                    previewH={preview.height}
                    containerW={previewContainerSize.width}
                  />
                )}
              </div>
            ) : (
              /* 无图可显示时：按宽高比显示骨架屏，不全屏 */
              <div
                className="max-w-full max-h-full rounded-sm overflow-hidden"
                style={{ aspectRatio, width: "100%", height: "100%" }}
              >
                <div className="w-full h-full bg-zinc-800/50 animate-pulse" />
              </div>
            )}
            {loading && displaySrc && (
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

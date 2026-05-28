import { useEffect, useLayoutEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon } from "lucide-react";
import { useGesture } from "@use-gesture/react";
import { api } from "@/api";
import type { FilterSettings, WatermarkSettings } from "@/types";
import { useStore } from "@/store";
import { formatBytes } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { renderWatermarkLayer } from "@/lib/watermarkCanvas";
import { isIdentityFilter } from "@/lib/filterIdentity";
import { useHistogramSync } from "@/hooks/useHistogramSync";

let previewTokenCounter = 0;

const INTERACTIVE_PREVIEW_MAX_EDGE = 960;
const GPU_INTERACTIVE_CANVAS_MAX_EDGE = 1280;
const SETTLED_PREVIEW_MAX_EDGE = 1920;
const INTERACTIVE_PREVIEW_DELAY_MS = 160;
const SETTLED_PREVIEW_DELAY_MS = 250;
const FULL_RESOLUTION_PREVIEW_OVERSAMPLE = 1.15;
const ZOOM_IDLE_DELAY_MS = 180;
const FILTER_SETTLE_DELAY_MS = 350;

type PreviewImage = {
  blobUrl: string;
  width: number;
  height: number;
};

type AssetPreviewImage = PreviewImage & {
  assetId: number;
};

const MIN_SCALE = 0.05;        // 绝对最小缩放比例 5%
const MAX_SCALE_FACTOR = 10;   // 相对 fit scale 的最大倍率
const MAX_SCALE_ABSOLUTE = 4;  // 绝对最大缩放（400%），保证小图也能放到 4x
const FIT_FILL = 0.8;

const PIPETTE_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2'%3E%3Cpath d='m2 22 1-1h3l9-9'/%3E%3Cpath d='M3 21v-3l9-9'/%3E%3Cpath d='m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3 3l3.8 3.8'/%3E%3C/svg%3E\") 2 20, crosshair";

export interface PreviewPanelHandle {
  fitToView: () => void;
  setZoomLevel: (scale: number) => void;
}

interface PreviewPanelProps {
  showOriginal: boolean;
  onScaleChange?: (scale: number, fitScale: number) => void;
}

export const PreviewPanel = forwardRef<PreviewPanelHandle, PreviewPanelProps>(function PreviewPanel(
  { showOriginal, onScaleChange },
  ref,
) {
  const { t } = useTranslation();
  const focusedId = useStore((s) => s.focusedId);
  const assets = useStore((s) => s.assets);
  const filter = useStore((s) => s.filter);
  const watermark = useStore((s) => s.watermark);
  const setPreviewSize = useStore((s) => s.setPreviewSize);
  const eyedropperMode = useStore((s) => s.eyedropperMode);
  const setEyedropperMode = useStore((s) => s.setEyedropperMode);
  const setFilter = useStore((s) => s.setFilter);
  const focused = assets.find((a) => a?.id === focusedId) ?? null;
  const isAdjustingFilter = useStore((s) => s.isAdjustingFilter);

  useHistogramSync(focusedId, filter);

  const [preview, setPreview] = useState<AssetPreviewImage | null>(null);
  const [baselinePreviews, setBaselinePreviews] = useState<Record<number, PreviewImage>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewRequestTick, setPreviewRequestTick] = useState(0);
  const loadingRef = useRef(false);
  const currentTokenRef = useRef(0);
  const previewRequestInFlightRef = useRef(false);
  const pendingPreviewRequestRef = useRef(false);
  const previewRef = useRef<AssetPreviewImage | null>(null);
  const baselinePreviewsRef = useRef<Record<number, PreviewImage>>({});
  const resolvedPreviewBasesRef = useRef<Set<number>>(new Set());

  const [scale, setScale] = useState<number>(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);
  // 隐藏图片直到 fit 计算完成，避免切换时闪烁到左上角
  const [imgVisible, setImgVisible] = useState(false);
  const [isZooming, setIsZooming] = useState(false);
  const [isFilterSettling, setIsFilterSettling] = useState(false);
  const [gpuInteractiveReady, setGpuInteractiveReady] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // 防止全分辨率预览替换缩略图时重复 fit
  const hasFitRef = useRef(false);
  const fitScaleRef = useRef(1);
  const zoomIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterSettlingRef = useRef(false);
  const focusedBaselinePreview = focused ? baselinePreviews[focused.id] ?? null : null;
  const gpuInteractiveSrc: string | null = (() => {
    if (!focused) return null;
    if (focused.is_raw) return focusedBaselinePreview?.blobUrl ?? null;
    try { return convertFileSrc(focused.file_path); } catch { return null; }
  })();
  const canUseGpuInteractivePreview =
    !!focused && (isAdjustingFilter || isFilterSettling) && !showOriginal && !!gpuInteractiveSrc;
  const nativeMaxEdge = Math.max(focused?.width ?? 0, focused?.height ?? 0);
  const fullResolutionScaleThreshold = nativeMaxEdge > SETTLED_PREVIEW_MAX_EDGE
    ? (SETTLED_PREVIEW_MAX_EDGE * FULL_RESOLUTION_PREVIEW_OVERSAMPLE)
      / (nativeMaxEdge * Math.max(window.devicePixelRatio || 1, 1))
    : Number.POSITIVE_INFINITY;
  const useFullResolutionPreview =
    !isAdjustingFilter && !isFilterSettling && !isZooming && scale >= fullResolutionScaleThreshold;

  const setPreviewLoading = useCallback((next: boolean) => {
    loadingRef.current = next;
    setLoading(next);
  }, []);

  const markZooming = useCallback(() => {
    setIsZooming(true);
    if (zoomIdleTimerRef.current) {
      clearTimeout(zoomIdleTimerRef.current);
    }
    zoomIdleTimerRef.current = setTimeout(() => {
      zoomIdleTimerRef.current = null;
      setIsZooming(false);
    }, ZOOM_IDLE_DELAY_MS);
  }, []);

  const startFilterSettling = useCallback(() => {
    filterSettlingRef.current = true;
    setIsFilterSettling(true);
    if (filterSettleTimerRef.current) {
      clearTimeout(filterSettleTimerRef.current);
    }
    filterSettleTimerRef.current = setTimeout(() => {
      filterSettleTimerRef.current = null;
      filterSettlingRef.current = false;
      setIsFilterSettling(false);
    }, FILTER_SETTLE_DELAY_MS);
  }, []);

  // 重置到 fit 状态：容器为图片原始尺寸，scale 缩放到占 viewport 80% 并居中
  // 优先用 store 里的 focused 尺寸（DB EXIF），缺失时回退到已加载 img 的 naturalWidth/Height，
  // 避免某些 RAW 没写标准 EXIF 尺寸字段时 fit 早退导致面板不可见。
  const resetToFit = useCallback(() => {
    const vp = viewportRef.current;
    const img = imgRef.current;
    const imgW = focused?.width || img?.naturalWidth || 0;
    const imgH = focused?.height || img?.naturalHeight || 0;
    if (!vp || !imgW || !imgH) return;
    const vpW = vp.clientWidth;
    const vpH = vp.clientHeight;
    const fit = Math.min(vpW / imgW, vpH / imgH) * FIT_FILL;
    fitScaleRef.current = fit;
    setContainerW(imgW);
    setContainerH(imgH);
    setScale(fit);
    setTx((vpW - imgW * fit) / 2);
    setTy((vpH - imgH * fit) / 2);
    setImgVisible(true);
  }, [focused?.width, focused?.height]);

  // 以视口中心为锚切换到指定 scale
  const setZoomLevel = useCallback((next: number) => {
    if (loadingRef.current) return;
    const vp = viewportRef.current;
    if (!vp) return;
    markZooming();
    const vpW = vp.clientWidth;
    const vpH = vp.clientHeight;
    setScale((prev) => {
      if (prev <= 0) return next;
      const ratio = next / prev;
      setTx((prevTx) => vpW / 2 - ratio * (vpW / 2 - prevTx));
      setTy((prevTy) => vpH / 2 - ratio * (vpH / 2 - prevTy));
      return next;
    });
  }, [markZooming]);

  useImperativeHandle(ref, () => ({
    fitToView: () => {
      if (!loadingRef.current) resetToFit();
    },
    setZoomLevel,
  }), [resetToFit, setZoomLevel]);

  // scale / fit 变化时上报
  useEffect(() => {
    onScaleChange?.(scale, fitScaleRef.current);
  }, [scale, onScaleChange]);

  useEffect(() => {
    if (!gpuInteractiveSrc) {
      setGpuInteractiveReady(false);
    }
  }, [gpuInteractiveSrc]);

  useLayoutEffect(() => {
    startFilterSettling();
  }, [filter]);

  useEffect(() => {
    return () => {
      if (zoomIdleTimerRef.current) {
        clearTimeout(zoomIdleTimerRef.current);
      }
      if (filterSettleTimerRef.current) {
        clearTimeout(filterSettleTimerRef.current);
      }
    };
  }, []);

  // 切换素材时重置 fit。用 useLayoutEffect 保证在浏览器 paint 之前同步完成布局，
  // 否则会先以「旧 scale + 新图」画一帧，视觉上像放大然后缩小。
  useLayoutEffect(() => {
    hasFitRef.current = false;
    setImgVisible(false);

    const vp = viewportRef.current;
    const imgW = focused?.width;
    const imgH = focused?.height;
    if (!vp || vp.clientWidth === 0 || vp.clientHeight === 0 || !imgW || !imgH) {
      // EXIF 没尺寸时不锁死 fitScale=1，留给 img onLoad → resetToFit 用 naturalWidth 兜底
      fitScaleRef.current = 1;
      return;
    }
    const vpW = vp.clientWidth;
    const vpH = vp.clientHeight;
    const fit = Math.min(vpW / imgW, vpH / imgH) * FIT_FILL;
    fitScaleRef.current = fit;
    setContainerW(imgW);
    setContainerH(imgH);
    setScale(fit);
    setTx((vpW - imgW * fit) / 2);
    setTy((vpH - imgH * fit) / 2);
  }, [focused?.id, focused?.width, focused?.height]);

  // 切换图片时获取原图，与 filter 变化解耦
  // 注意：本 effect 必须放在下面 getPreview effect 之后声明 / 之后执行，
  // 这样 currentTokenRef 已经被 getPreview effect 递增，二者使用同一个 token，
  // 避免 backend.preview_token 在 RAW 解码途中被 getPreview 覆盖导致 preview_cancelled。
  useEffect(() => {
    if (!focused) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }

    const token = ++previewTokenCounter;
    currentTokenRef.current = token;

    // When resetting to identity, clear the preview immediately so the canvas
    // shows the original instead of the old effect.
    // For normal adjustments, keep the old preview visible until new one arrives.
    const isIdentity = isIdentityFilter(filter);

    if (isIdentity) {
      previewRef.current = null;
      setPreview(null);
    }
    setError(null);
    const hasCurrentDisplay = focused.is_raw
      ? (
        previewRef.current?.assetId === focused.id ||
        !!baselinePreviewsRef.current[focused.id] ||
        resolvedPreviewBasesRef.current.has(focused.id)
      )
      : true;
    setPreviewLoading(false);

    if (focused.is_raw && !hasCurrentDisplay) {
      api.hasPreviewBase(focused.id)
        .then((hasBase) => {
          if (currentTokenRef.current !== token) return;
          if (hasBase) {
            resolvedPreviewBasesRef.current.add(focused.id);
          } else {
            setPreviewLoading(true);
          }
        })
        .catch(() => {
          if (currentTokenRef.current === token) setPreviewLoading(true);
        });
    }

    const filterSettlingNow = isFilterSettling || filterSettlingRef.current;
    const canUseGpuNow =
      !!focused && (isAdjustingFilter || filterSettlingNow) && !showOriginal && !!gpuInteractiveSrc;

    if (canUseGpuNow) {
      pendingPreviewRequestRef.current = false;
      return;
    }

    const previewMaxEdge = useFullResolutionPreview
      ? undefined
      : isAdjustingFilter
        ? INTERACTIVE_PREVIEW_MAX_EDGE
        : SETTLED_PREVIEW_MAX_EDGE;
    const previewMode = useFullResolutionPreview
      ? "full"
      : isAdjustingFilter
        ? "interactive"
        : "settled";
    const previewDelay = !hasCurrentDisplay
      ? 0
      : isAdjustingFilter || filterSettlingNow
        ? INTERACTIVE_PREVIEW_DELAY_MS
        : SETTLED_PREVIEW_DELAY_MS;

    if (previewRequestInFlightRef.current) {
      pendingPreviewRequestRef.current = true;
      return;
    }

    const handle = setTimeout(async () => {
      const isIdentity = isIdentityFilter(filter);

      if (currentTokenRef.current !== token) return;
      previewRequestInFlightRef.current = true;

      const schedulePendingPreview = () => {
        previewRequestInFlightRef.current = false;
        if (pendingPreviewRequestRef.current) {
          pendingPreviewRequestRef.current = false;
          setPreviewRequestTick((v) => v + 1);
        }
      };

      const doPreview = async () => {
        const r = await api.getPreview(focused.id, filter, previewMode, previewMaxEdge, token);
        if (currentTokenRef.current !== token) return;
        const src = convertFileSrc(r.path);
        if (isIdentity && focused.is_raw) {
          const nextBaseline = { blobUrl: src, width: r.width, height: r.height };
          setBaselinePreviews((prev) => {
            const next = { ...prev, [focused.id]: nextBaseline };
            baselinePreviewsRef.current = next;
            return next;
          });
          resolvedPreviewBasesRef.current.add(focused.id);
          previewRef.current = null;
          setPreview(null);
        } else {
          const nextPreview = { assetId: focused.id, blobUrl: src, width: r.width, height: r.height };
          previewRef.current = nextPreview;
          setPreview(nextPreview);
        }
        setPreviewSize({ width: r.width, height: r.height }, focused.id);
        setPreviewLoading(false);
      };

      try {
        await doPreview();
      } catch (e) {
        if (currentTokenRef.current !== token) {
          return;
        }
        if (String(e).includes("preview_cancelled")) {
          return;
        }
        if (String(e).includes("preview_busy")) {
          pendingPreviewRequestRef.current = true;
        } else {
          setError(String(e));
          setPreviewLoading(false);
        }
      } finally {
        schedulePendingPreview();
      }
    }, previewDelay);

    return () => clearTimeout(handle);
  }, [focused?.id, filter, isAdjustingFilter, isFilterSettling, useFullResolutionPreview, canUseGpuInteractivePreview, previewRequestTick]);

  // Clear preview when switching to a different photo, so old effect doesn't persist.
  useEffect(() => {
    previewRef.current = null;
    setPreview(null);
  }, [focused?.id]);

  const bind = useGesture(
    {
      onWheel: ({ delta: [, dy], event }) => {
        event.preventDefault();
        if (loadingRef.current) return;
        const vp = viewportRef.current;
        if (!vp) return;
        markZooming();
        const rect = vp.getBoundingClientRect();
        const mouseX = (event as WheelEvent).clientX - rect.left;
        const mouseY = (event as WheelEvent).clientY - rect.top;

        setScale((prevScale) => {
          const fitScale = fitScaleRef.current;
          const factor = Math.pow(0.999, dy);
          // 上限取 fit*10 与绝对 400% 的较大者，保证小图也能放到 4x
          const maxScale = Math.max(fitScale * MAX_SCALE_FACTOR, MAX_SCALE_ABSOLUTE);
          const next = Math.max(MIN_SCALE, Math.min(maxScale, prevScale * factor));
          const ratio = next / prevScale;
          setTx((prevTx) => mouseX - ratio * (mouseX - prevTx));
          setTy((prevTy) => mouseY - ratio * (mouseY - prevTy));
          return next;
        });
      },
      onDrag: ({ delta: [dx, dy], event }) => {
        event.preventDefault();
        setTx((prev) => prev + dx);
        setTy((prev) => prev + dy);
      },
      onDoubleClick: () => {
        if (loadingRef.current) return;
        markZooming();
        resetToFit();
      },
    },
    {
      wheel: { eventOptions: { passive: false } },
      drag: { filterTaps: true, eventOptions: { passive: false } },
    },
  );

  const handleEyedropperClick = useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      if (eyedropperMode === 'none' || !focusedId) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const displayWidth = rect.width;
      const displayHeight = rect.height;

      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      // Get image natural dimensions from the img element
      const img = imgRef.current;
      if (!img) return;

      const imgWidth = img.naturalWidth;
      const imgHeight = img.naturalHeight;
      if (!imgWidth || !imgHeight) return;

      // Calculate the actual rendered image dimensions (object-fit: contain)
      const imgAspect = imgWidth / imgHeight;
      const containerAspect = displayWidth / displayHeight;

      let renderedWidth: number, renderedHeight: number, offsetX: number, offsetY: number;

      if (imgAspect > containerAspect) {
        renderedWidth = displayWidth;
        renderedHeight = displayWidth / imgAspect;
        offsetX = 0;
        offsetY = (displayHeight - renderedHeight) / 2;
      } else {
        renderedHeight = displayHeight;
        renderedWidth = displayHeight * imgAspect;
        offsetX = (displayWidth - renderedWidth) / 2;
        offsetY = 0;
      }

      const imgX = Math.round(((clickX - offsetX) / renderedWidth) * imgWidth);
      const imgY = Math.round(((clickY - offsetY) / renderedHeight) * imgHeight);

      if (imgX < 0 || imgX >= imgWidth || imgY < 0 || imgY >= imgHeight) return;

      try {
        const { r, g, b } = await api.eyedropColor(focusedId, imgX, imgY);
        const avg = (r + g + b) / 3;
        if (avg < 1) return;
        const wbShiftR = Math.round(Math.max(-100, Math.min(100, ((avg - r) / r) * 200)));
        const wbShiftG = Math.round(Math.max(-100, Math.min(100, ((avg - g) / g) * 200)));
        const wbShiftB = Math.round(Math.max(-100, Math.min(100, ((avg - b) / b) * 200)));
        setFilter({ wb_shift_r: wbShiftR, wb_shift_g: wbShiftG, wb_shift_b: wbShiftB });
      } catch (err) {
        console.error('Eyedropper failed:', err);
      } finally {
        setEyedropperMode('none');
      }
    },
    [eyedropperMode, focusedId, setFilter, setEyedropperMode],
  );

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

  const currentPreview = preview?.assetId === focused.id ? preview : null;
  const currentBaselinePreview = focusedBaselinePreview;
  const previewSrc = currentPreview?.blobUrl ?? null;
  const baselineSrc = currentBaselinePreview?.blobUrl ?? null;
  const originalSrc = focused.is_raw ? baselineSrc : convertFileSrc(focused.file_path);
  const showingOriginal = showOriginal && !!originalSrc;

  const placeholderSrc: string | null = (() => {
    if (focused.is_raw) {
      return null;
    }
    try { return convertFileSrc(focused.file_path); } catch { return null; }
  })();

  const displaySrc = previewSrc ?? baselineSrc ?? placeholderSrc;
  const hasImageSource = !!displaySrc || !!originalSrc;
  const canShowSkeleton = !!focused.width && !!focused.height && !!containerW && !!containerH;
  const showSkeleton = canShowSkeleton && loading && !hasImageSource;

  const wmDims: { width: number; height: number } | null = (() => {
    if (focused.width && focused.height) return { width: focused.width, height: focused.height };
    if (currentPreview?.width && currentPreview?.height) return { width: currentPreview.width, height: currentPreview.height };
    if (currentBaselinePreview?.width && currentBaselinePreview?.height) {
      return { width: currentBaselinePreview.width, height: currentBaselinePreview.height };
    }
    const nw = imgRef.current?.naturalWidth;
    const nh = imgRef.current?.naturalHeight;
    if (nw && nh) return { width: nw, height: nh };
    return null;
  })();

  return (
    <main className="w-full h-full flex flex-col bg-transparent min-w-0">
      <div
        ref={viewportRef}
        className={`flex-1 relative overflow-hidden bg-zinc-950/20 ${eyedropperMode !== 'none' ? '' : 'cursor-grab active:cursor-grabbing'}`}
        onClick={handleEyedropperClick}
        {...bind()}
        style={{
          touchAction: "none",
          ...(eyedropperMode !== 'none' ? { cursor: PIPETTE_CURSOR } : {}),
        }}
      >
        {scale !== null && (
          <>
            {error ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-zinc-400 text-sm bg-zinc-900/80 px-4 py-2 rounded border border-zinc-800">
                  {error}
                </div>
              </div>
            ) : displaySrc || originalSrc || showSkeleton ? (
              <div
                style={{
                  transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                  transformOrigin: "0 0",
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: containerW || undefined,
                  height: containerH || undefined,
                  lineHeight: 0,
                }}
              >
                {showSkeleton && (
                  <div
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      inset: 0,
                      overflow: "hidden",
                      background: "rgba(24, 24, 27, 0.7)",
                    }}
                  >
                    <div className="h-full w-full animate-pulse bg-gradient-to-br from-zinc-800 via-zinc-700/70 to-zinc-900" />
                  </div>
                )}
                {displaySrc && (
                  <img
                    ref={imgRef}
                    src={displaySrc}
                    alt="preview"
                    style={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                      opacity: imgVisible && !showingOriginal && !(canUseGpuInteractivePreview && gpuInteractiveReady) ? 1 : 0,
                      WebkitUserSelect: "none",
                      WebkitTouchCallout: "none",
                    }}
                    draggable={false}
                    onLoad={(e) => {
                      const el = e.currentTarget as HTMLImageElement;
                      console.log("[PreviewPanel] onLoad", el.src, el.naturalWidth, "x", el.naturalHeight);
                      if (previewSrc || baselineSrc) {
                        if (!hasFitRef.current) {
                          hasFitRef.current = true;
                          resetToFit();
                        } else {
                          setImgVisible(true);
                        }
                      } else {
                        setImgVisible(true);
                      }
                    }}
                    onError={(e) => {
                      // asset:// 协议加载失败时浏览器默认静默；这里把错误冒出来，
                      // 否则 imgVisible 永远是 false，整个面板卡在不可见状态。
                      const failedSrc = (e.currentTarget as HTMLImageElement).src;
                      console.error("[PreviewPanel] image load failed:", failedSrc);
                      setError(t("previewPanel.loadFailed"));
                      setImgVisible(true);
                    }}
                  />
                )}
                {showingOriginal && (
                  <img
                    src={originalSrc}
                    alt="original"
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                    }}
                    draggable={false}
                  />
                )}
                {gpuInteractiveSrc && (
                  <GpuInteractivePreviewCanvas
                    src={gpuInteractiveSrc}
                    filter={filter}
                    visible={imgVisible && canUseGpuInteractivePreview && gpuInteractiveReady}
                    onReadyChange={setGpuInteractiveReady}
                  />
                )}
                {!showOriginal && watermark.enabled && wmDims && (
                  <WatermarkOverlay
                    wm={watermark}
                    imgW={wmDims.width}
                    imgH={wmDims.height}
                  />
                )}
              </div>
            ) : loading ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex flex-col items-center justify-center gap-3 text-zinc-500">
                  <div className="relative w-10 h-10">
                    <div className="absolute inset-0 rounded-full border-2 border-zinc-600 animate-ping opacity-60" />
                    <div className="absolute inset-1.5 rounded-full bg-zinc-600 animate-pulse" />
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}
        {loading && displaySrc && (
          <div className="absolute top-3 left-3 text-xs text-zinc-400 bg-zinc-950/60 px-2 py-1 rounded">
            {t("previewPanel.rendering")}
          </div>
        )}
        {!!focused.width && !!focused.height && displaySrc && (
          <div className="absolute bottom-3 right-3 text-[10px] text-zinc-500 bg-zinc-950/60 px-2 py-1 rounded">
            {focused.width} × {focused.height} · {formatBytes(focused.file_size)}
          </div>
        )}
      </div>
    </main>
  );
});

function WatermarkOverlay({
  wm,
  imgW,
  imgH,
}: {
  wm: WatermarkSettings;
  imgW: number;
  imgH: number;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const MAX = 1280;
    const s = Math.min(1, MAX / Math.max(imgW, imgH));
    const canvasW = Math.round(imgW * s);
    const canvasH = Math.round(imgH * s);
    // canvas 用缩小尺寸，fontSize 不缩放（保持用户设置值），img CSS 再拉伸到原图尺寸
    renderWatermarkLayer(wm, canvasW, canvasH, 1).then((result) => {
      if (!cancelled) setDataUrl(`data:image/png;base64,${result.data}`);
    });
    return () => { cancelled = true; };
  }, [wm, imgW, imgH]);

  if (!dataUrl) return null;
  return (
    <img
      src={dataUrl}
      alt=""
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: imgW,
        height: imgH,
        pointerEvents: "none",
      }}
    />
  );
}

function GpuInteractivePreviewCanvas({
  src,
  filter,
  visible,
  onReadyChange,
}: {
  src: string;
  filter: FilterSettings;
  visible: boolean;
  onReadyChange: (ready: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glStateRef = useRef<{
    gl: WebGLRenderingContext;
    program: WebGLProgram;
    texture: WebGLTexture;
    buffer: WebGLBuffer;
    vertexShader: WebGLShader;
    fragmentShader: WebGLShader;
    uniforms: {
      exposure: WebGLUniformLocation | null;
      brightness: WebGLUniformLocation | null;
      contrast: WebGLUniformLocation | null;
      saturation: WebGLUniformLocation | null;
      wb: WebGLUniformLocation | null;
    };
  } | null>(null);
  const latestFilterRef = useRef(filter);
  const drawRafRef = useRef<number | null>(null);

  useEffect(() => {
    latestFilterRef.current = filter;
  }, [filter]);

  const draw = useCallback((settings: FilterSettings) => {
    const state = glStateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas) return false;

    const { gl, program } = state;
    const cssW = Math.max(1, canvas.clientWidth);
    const cssH = Math.max(1, canvas.clientHeight);
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const scale = Math.min(1, GPU_INTERACTIVE_CANVAS_MAX_EDGE / Math.max(cssW, cssH));
    const width = Math.max(1, Math.round(cssW * dpr * scale));
    const height = Math.max(1, Math.round(cssH * dpr * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.uniform1f(state.uniforms.exposure, settings.exposure);
    gl.uniform1f(state.uniforms.brightness, settings.brightness * 0.005);
    gl.uniform1f(state.uniforms.contrast, 1 + settings.contrast * 0.01);
    gl.uniform1f(
      state.uniforms.saturation,
      Math.max(0, 1 + (settings.color_saturation + settings.vibrance * 0.5) * 0.01),
    );
    gl.uniform3f(
      state.uniforms.wb,
      1 + settings.wb_shift_r * 0.005,
      1 + settings.wb_shift_g * 0.005,
      1 + settings.wb_shift_b * 0.005,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return true;
  }, []);

  const scheduleDraw = useCallback((settings: FilterSettings) => {
    latestFilterRef.current = settings;
    if (drawRafRef.current != null) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = null;
      if (draw(latestFilterRef.current)) {
        onReadyChange(true);
      }
    });
  }, [draw, onReadyChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    onReadyChange(false);

    const cleanup = () => {
      if (drawRafRef.current != null) {
        cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }
      const state = glStateRef.current;
      if (!state) return;
      state.gl.deleteTexture(state.texture);
      state.gl.deleteBuffer(state.buffer);
      state.gl.deleteShader(state.vertexShader);
      state.gl.deleteShader(state.fragmentShader);
      state.gl.deleteProgram(state.program);
      glStateRef.current = null;
    };
    cleanup();

    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (cancelled) return;

      const gl = canvas.getContext("webgl", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      });
      if (!gl) return;

      const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
        attribute vec2 a_position;
        attribute vec2 a_texCoord;
        varying vec2 v_texCoord;
        void main() {
          gl_Position = vec4(a_position, 0.0, 1.0);
          v_texCoord = a_texCoord;
        }
      `);
      const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
        precision mediump float;
        uniform sampler2D u_image;
        uniform float u_exposure;
        uniform float u_brightness;
        uniform float u_contrast;
        uniform float u_saturation;
        uniform vec3 u_wb;
        varying vec2 v_texCoord;

        vec3 applySaturation(vec3 c, float sat) {
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          return mix(vec3(l), c, sat);
        }

        void main() {
          vec3 c = texture2D(u_image, v_texCoord).rgb;
          float l0 = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.00001);
          c *= u_wb;
          float l1 = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.00001);
          c *= l0 / l1;
          c *= pow(2.0, u_exposure);
          c += vec3(u_brightness);
          c = (c - vec3(0.5)) * u_contrast + vec3(0.5);
          c = applySaturation(c, u_saturation);
          gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        }
      `);
      const program = linkProgram(gl, vertexShader, fragmentShader);
      gl.useProgram(program);

      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          -1, -1, 0, 1,
           1, -1, 1, 1,
          -1,  1, 0, 0,
          -1,  1, 0, 0,
           1, -1, 1, 1,
           1,  1, 1, 0,
        ]),
        gl.STATIC_DRAW,
      );

      const stride = 4 * 4;
      const posLoc = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);
      const texLoc = gl.getAttribLocation(program, "a_texCoord");
      gl.enableVertexAttribArray(texLoc);
      gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, stride, 2 * 4);

      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

      glStateRef.current = {
        gl,
        program,
        texture,
        buffer,
        vertexShader,
        fragmentShader,
        uniforms: {
          exposure: gl.getUniformLocation(program, "u_exposure"),
          brightness: gl.getUniformLocation(program, "u_brightness"),
          contrast: gl.getUniformLocation(program, "u_contrast"),
          saturation: gl.getUniformLocation(program, "u_saturation"),
          wb: gl.getUniformLocation(program, "u_wb"),
        },
      };
      if (draw(latestFilterRef.current)) {
        onReadyChange(true);
      }
    };
    image.src = src;

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [src, draw, onReadyChange]);

  useEffect(() => {
    scheduleDraw(filter);
  }, [filter, scheduleDraw]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity: visible ? 1 : 0,
        pointerEvents: "none",
      }}
    />
  );
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || "shader compile failed";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function linkProgram(
  gl: WebGLRenderingContext,
  vertexShader: WebGLShader,
  fragmentShader: WebGLShader,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || "program link failed";
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

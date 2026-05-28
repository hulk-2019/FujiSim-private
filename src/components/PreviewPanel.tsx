import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon } from "lucide-react";
import { useStore } from "@/store";
import { formatBytes } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { isIdentityFilter } from "@/lib/filterIdentity";
import { useHistogramSync } from "@/hooks/useHistogramSync";
import { canApproximateWithGpu } from "@/components/preview/filterApproximation";
import { GpuInteractivePreviewCanvas } from "@/components/preview/GpuInteractivePreviewCanvas";
import { WatermarkOverlay } from "@/components/preview/WatermarkOverlay";
import { useEyedropper } from "@/components/preview/useEyedropper";
import {
  usePreviewGestures,
  useZoomToLevel,
} from "@/components/preview/usePreviewGestures";
import { usePreviewLoader } from "@/components/preview/usePreviewLoader";
import { useFullResolutionPreviewTrigger } from "@/components/preview/useFullResolutionPreviewTrigger";
import { usePreviewInteractionMarker } from "@/components/preview/usePreviewInteractionMarker";
import { useElementSize } from "@/components/preview/useElementSize";
import { useTilePreview } from "@/components/preview/useTilePreview";
import { TilePreviewOverlay } from "@/components/preview/TilePreviewOverlay";

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

export const PreviewPanel = forwardRef<PreviewPanelHandle, PreviewPanelProps>(
  function PreviewPanel({ showOriginal, onScaleChange }, ref) {
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
    const filterInteraction = useStore((s) => s.filterInteraction);
    const setFilterInteraction = useStore((s) => s.setFilterInteraction);

    useHistogramSync(focusedId, filter);
    usePreviewInteractionMarker({
      filter,
      filterInteraction,
      isAdjustingFilter,
    });

    const [scale, setScale] = useState<number>(1);
    const [tx, setTx] = useState(0);
    const [ty, setTy] = useState(0);
    const [containerW, setContainerW] = useState(0);
    const [containerH, setContainerH] = useState(0);
    // 隐藏图片直到 fit 计算完成，避免切换时闪烁到左上角
    const [imgVisible, setImgVisible] = useState(false);
    const [gpuInteractiveReady, setGpuInteractiveReady] = useState(false);
    const [gpuHandoffActive, setGpuHandoffActive] = useState(false);

    const viewportRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const viewportSize = useElementSize(viewportRef);
    // 防止全分辨率预览替换缩略图时重复 fit
    const hasFitRef = useRef(false);
    const fitScaleRef = useRef(1);
    const wasAdjustingFilterRef = useRef(false);
    const currentFilterIsIdentity = isIdentityFilter(filter);
    const canApproximateCurrentFilter = canApproximateWithGpu(filter);
    const approximateFilterWithGpu =
      isAdjustingFilter ||
      filterInteraction === "preset_applied" ||
      filterInteraction === "settling";
    const { useFullResolutionPreview } = useFullResolutionPreviewTrigger({
      nativeWidth: focused?.width,
      nativeHeight: focused?.height,
      scale,
      filter,
      isAdjustingFilter,
    });
    const useTileDetailPreview = useFullResolutionPreview && !showOriginal;

    const { preview, baselinePreviews, loading, loadingRef, initializingBase, error } =
      usePreviewLoader({
        focused,
        filter,
        isIdentity: currentFilterIsIdentity,
        isAdjustingFilter,
        showOriginal,
        canUseGpuInteractivePreview:
          !!focused &&
          !currentFilterIsIdentity &&
          canApproximateCurrentFilter &&
          approximateFilterWithGpu &&
          !showOriginal,
        useFullResolutionPreview: useFullResolutionPreview && !useTileDetailPreview,
        setPreviewSize,
      });
    const focusedBaselinePreview = focused
      ? (baselinePreviews[focused.id] ?? null)
      : null;
    const focusedPreviewImage =
      focused &&
      preview?.assetId === focused.id &&
      (!currentFilterIsIdentity || (useFullResolutionPreview && !useTileDetailPreview))
        ? preview
        : null;
    const gpuInteractiveSrc: string | null = (() => {
      if (!focused) return null;
      return focusedBaselinePreview?.blobUrl ?? null;
    })();
    const canUseGpuInteractivePreview =
      !!focused &&
      !currentFilterIsIdentity &&
      canApproximateCurrentFilter &&
      !showOriginal &&
      !!gpuInteractiveSrc;
    const markZooming = useCallback(() => {}, []);
    const tilePreviews = useTilePreview({
      focused,
      filter,
      enabled: useTileDetailPreview && !approximateFilterWithGpu && imgVisible,
      scale,
      tx,
      ty,
      viewportWidth: viewportSize.width,
      viewportHeight: viewportSize.height,
      imageWidth: focused?.width ?? containerW,
      imageHeight: focused?.height ?? containerH,
    });

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

    const setZoomLevel = useZoomToLevel({
      viewportRef,
      loadingRef,
      markZooming,
      setScale,
      setTx,
      setTy,
    });

    useImperativeHandle(
      ref,
      () => ({
        fitToView: () => {
          if (!loadingRef.current) resetToFit();
        },
        setZoomLevel,
      }),
      [resetToFit, setZoomLevel],
    );

    // scale / fit 变化时上报
    useEffect(() => {
      onScaleChange?.(scale, fitScaleRef.current);
    }, [scale, onScaleChange]);

    useEffect(() => {
      if (!gpuInteractiveSrc) {
        setGpuInteractiveReady(false);
      }
    }, [gpuInteractiveSrc]);

    const shouldApproximateWithGpu = canUseGpuInteractivePreview && approximateFilterWithGpu;

    useLayoutEffect(() => {
      if (!canUseGpuInteractivePreview || currentFilterIsIdentity) {
        setGpuHandoffActive(false);
        wasAdjustingFilterRef.current = isAdjustingFilter;
        return;
      }

      if (
        wasAdjustingFilterRef.current &&
        !isAdjustingFilter &&
        gpuInteractiveReady
      ) {
        setGpuHandoffActive(true);
      }
      wasAdjustingFilterRef.current = isAdjustingFilter;
    }, [canUseGpuInteractivePreview, currentFilterIsIdentity, gpuInteractiveReady, isAdjustingFilter]);

    useEffect(() => {
      setGpuHandoffActive(false);
      wasAdjustingFilterRef.current = false;
      setFilterInteraction("idle");
    }, [focused?.id]);

    useEffect(() => {
      if (filterInteraction !== "preset_applied") return;
      const handle = setTimeout(() => setFilterInteraction("settling"), 450);
      return () => clearTimeout(handle);
    }, [filterInteraction, setFilterInteraction]);

    // 切换素材时重置 fit。用 useLayoutEffect 保证在浏览器 paint 之前同步完成布局，
    // 否则会先以「旧 scale + 新图」画一帧，视觉上像放大然后缩小。
    useLayoutEffect(() => {
      hasFitRef.current = false;
      setImgVisible(false);

      const vp = viewportRef.current;
      const imgW = focused?.width;
      const imgH = focused?.height;
      if (
        !vp ||
        vp.clientWidth === 0 ||
        vp.clientHeight === 0 ||
        !imgW ||
        !imgH
      ) {
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

    const bind = usePreviewGestures({
      viewportRef,
      loadingRef,
      fitScaleRef,
      markZooming,
      resetToFit,
      setScale,
      setTx,
      setTy,
    });

    const handleEyedropperClick = useEyedropper({
      focusedId,
      eyedropperMode,
      imgRef,
      setFilter,
      setEyedropperMode,
    });

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

    const currentPreview = focusedPreviewImage;
    const currentBaselinePreview = focusedBaselinePreview;
    const previewSrc = currentPreview?.blobUrl ?? null;
    const baselineSrc = currentBaselinePreview?.blobUrl ?? null;
    const originalSrc = focused.is_raw
      ? baselineSrc
      : convertFileSrc(focused.file_path);
    const showingOriginal = showOriginal && !!originalSrc;

    const placeholderSrc: string | null = (() => {
      if (focused.is_raw) {
        return null;
      }
      try {
        return convertFileSrc(focused.file_path);
      } catch {
        return null;
      }
    })();

    const displaySrc = previewSrc ?? baselineSrc ?? placeholderSrc;
    const hasImageSource = !!displaySrc || !!originalSrc;
    const canShowSkeleton =
      !!focused.width && !!focused.height && !!containerW && !!containerH;
    const showSkeleton = canShowSkeleton && initializingBase && !hasImageSource;
    const showGpuInteractiveLayer =
      imgVisible &&
      !showOriginal &&
      !!gpuInteractiveSrc &&
      gpuInteractiveReady &&
      canUseGpuInteractivePreview &&
      (shouldApproximateWithGpu || gpuHandoffActive);

    const wmDims: { width: number; height: number } | null = (() => {
      if (focused.width && focused.height)
        return { width: focused.width, height: focused.height };
      if (currentPreview?.width && currentPreview?.height)
        return { width: currentPreview.width, height: currentPreview.height };
      if (currentBaselinePreview?.width && currentBaselinePreview?.height) {
        return {
          width: currentBaselinePreview.width,
          height: currentBaselinePreview.height,
        };
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
          className={`flex-1 relative overflow-hidden bg-zinc-950/20 ${eyedropperMode !== "none" ? "" : "cursor-grab active:cursor-grabbing"}`}
          onClick={handleEyedropperClick}
          {...bind()}
          style={{
            touchAction: "none",
            ...(eyedropperMode !== "none" ? { cursor: PIPETTE_CURSOR } : {}),
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
                        opacity:
                          imgVisible &&
                          !showingOriginal &&
                          !showGpuInteractiveLayer
                            ? 1
                            : 0,
                        WebkitUserSelect: "none",
                        WebkitTouchCallout: "none",
                      }}
                      draggable={false}
                      onLoad={(e) => {
                        const el = e.currentTarget as HTMLImageElement;
                        if (
                          gpuHandoffActive &&
                          previewSrc &&
                          el.src === previewSrc
                        ) {
                          setGpuHandoffActive(false);
                          setFilterInteraction("idle");
                        } else if (previewSrc && el.src === previewSrc) {
                          setFilterInteraction("idle");
                        }
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
                        const failedSrc = (e.currentTarget as HTMLImageElement)
                          .src;
                        console.error(
                          "[PreviewPanel] image load failed:",
                          failedSrc,
                        );
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
                      visible={showGpuInteractiveLayer}
                      onReadyChange={setGpuInteractiveReady}
                    />
                  )}
                  <TilePreviewOverlay tilePreviews={tilePreviews} assetId={focused.id} />
                  {!showOriginal && watermark.enabled && wmDims && (
                    <WatermarkOverlay
                      wm={watermark}
                      imgW={wmDims.width}
                      imgH={wmDims.height}
                    />
                  )}
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
              {focused.width} × {focused.height} ·{" "}
              {formatBytes(focused.file_size)}
            </div>
          )}
        </div>
      </main>
    );
  },
);

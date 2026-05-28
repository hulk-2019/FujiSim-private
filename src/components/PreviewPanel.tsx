import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
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
import { useGpuPreviewHandoff } from "@/components/preview/useGpuPreviewHandoff";
import {
  focusedPreviewImage,
  previewDisplayState,
  watermarkDimensions,
} from "@/components/preview/previewDisplayState";
import { usePreviewFit } from "@/components/preview/usePreviewFit";

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
    const projectId = useStore((s) => s.currentFolderId);
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

    const viewportRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const viewportSize = useElementSize(viewportRef);
    const {
      containerH,
      containerW,
      fitScaleRef,
      hasFitRef,
      imgVisible,
      resetToFit,
      scale,
      setImgVisible,
      setScale,
      setTx,
      setTy,
      tx,
      ty,
    } = usePreviewFit({ focused, imgRef, onScaleChange, viewportRef });
    const [gpuInteractiveReady, setGpuInteractiveReady] = useState(false);
    const currentFilterIsIdentity = isIdentityFilter(filter);
    const canApproximateCurrentFilter = canApproximateWithGpu(filter);
    // GPU 近似只覆盖交互阶段；后端 settled 图仍然是最终权威结果。
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

    const { preview, baselinePreviews, loading, loadingMode, loadingRef, initializingBase, error } =
      usePreviewLoader({
        focused,
        filter,
        isIdentity: currentFilterIsIdentity,
        isAdjustingFilter,
        filterInteraction,
        showOriginal,
        canUseGpuInteractivePreview:
          !!focused &&
          !currentFilterIsIdentity &&
          canApproximateCurrentFilter &&
          approximateFilterWithGpu &&
          !showOriginal,
        useFullResolutionPreview: useFullResolutionPreview && !useTileDetailPreview,
        projectId,
        setPreviewSize,
      });
    const focusedBaselinePreview = focused
      ? (baselinePreviews[focused.id] ?? null)
      : null;
    const currentPreviewImage = focusedPreviewImage({
      focused,
      preview,
      filterIsIdentity: currentFilterIsIdentity,
      useFullResolutionPreview,
      useTileDetailPreview,
    });
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
    const { gpuHandoffActive, setGpuHandoffActive } = useGpuPreviewHandoff({
      focusedId,
      canUseGpuInteractivePreview,
      filterIsIdentity: currentFilterIsIdentity,
      filterInteraction,
      gpuInteractiveReady,
      isAdjustingFilter,
      setFilterInteraction,
    });
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
      projectId,
    });

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

    useEffect(() => {
      if (!gpuInteractiveSrc) {
        setGpuInteractiveReady(false);
      }
    }, [gpuInteractiveSrc]);

    const shouldApproximateWithGpu = canUseGpuInteractivePreview && approximateFilterWithGpu;

    useEffect(() => {
      // 预设/白平衡这类一次性操作先展示 GPU 近似效果，再延迟进入后端 settled 渲染。
      if (filterInteraction !== "preset_applied") return;
      const handle = setTimeout(() => setFilterInteraction("settling"), 450);
      return () => clearTimeout(handle);
    }, [filterInteraction, setFilterInteraction]);

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
      projectId,
      eyedropperMode,
      viewportRef,
      imageTransform: { scale, tx, ty, width: containerW, height: containerH },
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

    const currentPreview = currentPreviewImage;
    const currentBaselinePreview = focusedBaselinePreview;
    const {
      baselineSrc,
      displaySrc,
      originalSrc,
      previewSrc,
      showingOriginal,
      showGpuInteractiveLayer,
      showSkeleton,
    } = previewDisplayState({
      focused,
      currentPreview,
      currentBaselinePreview,
      containerW,
      containerH,
      gpuHandoffActive,
      gpuInteractiveReady,
      gpuInteractiveSrc,
      imgVisible,
      initializingBase,
      canUseGpuInteractivePreview,
      shouldApproximateWithGpu,
      showOriginal,
    });

    const wmDims = watermarkDimensions({
      baselinePreview: currentBaselinePreview,
      focused,
      imageNaturalHeight: imgRef.current?.naturalHeight,
      imageNaturalWidth: imgRef.current?.naturalWidth,
      preview: currentPreview,
    });
    const showRenderingBadge =
      loading &&
      loadingMode !== "interactive" &&
      !!displaySrc &&
      !showGpuInteractiveLayer &&
      !isAdjustingFilter;

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
                        // 后端权威预览真正加载进 <img> 后，才释放 GPU 接管层。
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
                      src={originalSrc ?? undefined}
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
          {showRenderingBadge && (
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

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
  type CSSProperties,
  type ReactEventHandler,
} from "react";
import { ImageIcon } from "lucide-react";
import { useStore } from "@/store";
import { formatBytes } from "@/lib/utils";
import { isOrientationSwapped, orientationTransform } from "@/lib/orientation";
import { useTranslation } from "react-i18next";
import { isIdentityFilter } from "@/lib/filterIdentity";
import { useHistogramSync } from "@/hooks/useHistogramSync";
import { canApproximateWithGpu } from "@/components/preview/filterApproximation";
import { GpuInteractivePreviewCanvas } from "@/components/preview/GpuInteractivePreviewCanvas";
import { containedImageRect, WatermarkOverlay } from "@/components/preview/WatermarkOverlay";
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

type DisplayFrame = {
  containerH: number;
  containerW: number;
  orientation?: number | null;
  scale: number;
  src: string;
  tx: number;
  ty: number;
};

function orientationStyle(
  orientation: number | null | undefined,
  containerW: number,
  containerH: number,
): CSSProperties {
  const swapped = isOrientationSwapped(orientation);
  const base: CSSProperties = swapped
    ? {
        position: "absolute",
        left: (containerW - containerH) / 2,
        top: (containerH - containerW) / 2,
        width: containerH,
        height: containerW,
        transformOrigin: "center center",
      }
    : {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        transformOrigin: "center center",
      };

  const transform = orientationTransform(orientation);
  return transform ? { ...base, transform } : base;
}

function OrientedImage({
  alt,
  className,
  containerH,
  containerW,
  draggable = false,
  objectFit,
  onError,
  onLoad,
  opacity,
  orientation,
  src,
  style,
}: {
  alt: string;
  className?: string;
  containerH: number;
  containerW: number;
  draggable?: boolean;
  objectFit: CSSProperties["objectFit"];
  onError?: ReactEventHandler<HTMLImageElement>;
  onLoad?: ReactEventHandler<HTMLImageElement>;
  opacity: number;
  orientation?: number | null;
  src: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={className}
      style={{
        ...orientationStyle(orientation, containerW, containerH),
        opacity,
        pointerEvents: "none",
        transition: "none",
      }}
    >
      <img
        src={src}
        alt={alt}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          objectFit,
          filter: "none",
          transition: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
          ...style,
        }}
        draggable={draggable}
        onLoad={onLoad}
        onError={onError}
      />
    </div>
  );
}

export const PreviewPanel = forwardRef<PreviewPanelHandle, PreviewPanelProps>(
  function PreviewPanel({ showOriginal, onScaleChange }, ref) {
    const { t } = useTranslation();
    const focusedId = useStore((s) => s.focusedId);
    const assets = useStore((s) => s.assets);
    const projectId = useStore((s) => s.currentFolderId);
    const filter = useStore((s) => s.filter);
    const watermark = useStore((s) => s.watermark);
    const previewSize = useStore((s) => s.previewSize);
    const previewSizeAssetId = useStore((s) => s.previewSizeAssetId);
    const setPreviewSize = useStore((s) => s.setPreviewSize);
    const setWatermarkPreviewSize = useStore((s) => s.setWatermarkPreviewSize);
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
    const viewportSize = useElementSize(viewportRef);
    const fallbackFitSize =
      previewSizeAssetId === focusedId ? previewSize : null;
    const {
      containerH,
      containerW,
      fitScale,
      imgVisible,
      resetToFit,
      scale,
      setScale,
      setTx,
      setTy,
      tx,
      ty,
    } = usePreviewFit({
      fallbackSize: fallbackFitSize,
      focused,
      onScaleChange,
      viewportRef,
    });
    const [gpuInteractiveReady, setGpuInteractiveReady] = useState(false);
    const [loadedMainSrc, setLoadedMainSrc] = useState<string | null>(null);
    const [lastDisplayFrame, setLastDisplayFrame] =
      useState<DisplayFrame | null>(null);
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

    const {
      preview,
      baselinePreviews,
      placeholders,
      loading,
      loadingMode,
      initializingBase,
      error,
    } =
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
    const focusedPlaceholder = focused ? (placeholders[focused.id] ?? null) : null;
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
    const sourceCoordinateSize =
      focused?.width && focused.height
        ? { width: focused.width, height: focused.height }
        : { width: containerW, height: containerH };
    const toSourceCoordinate = useCallback(
      (x: number, y: number) => ({
        x:
          containerW && sourceCoordinateSize.width
            ? Math.round((x / containerW) * sourceCoordinateSize.width)
            : x,
        y:
          containerH && sourceCoordinateSize.height
            ? Math.round((y / containerH) * sourceCoordinateSize.height)
            : y,
      }),
      [containerH, containerW, sourceCoordinateSize.height, sourceCoordinateSize.width],
    );
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
      imageWidth: sourceCoordinateSize.width,
      imageHeight: sourceCoordinateSize.height,
      displayWidth: containerW,
      displayHeight: containerH,
      projectId,
    });

    const setZoomLevel = useZoomToLevel({
      viewportRef,
      markZooming,
      setScale,
      setTx,
      setTy,
    });

    useImperativeHandle(
      ref,
      () => ({
        fitToView: () => {
          resetToFit();
        },
        setZoomLevel,
      }),
      [resetToFit, setZoomLevel],
    );

    const rememberDisplayFrame = useCallback(
      (src: string | null, orientation?: number | null) => {
        if (!src || !containerW || !containerH || !scale) return;
        setLastDisplayFrame({
          containerH,
          containerW,
          orientation,
          scale,
          src,
          tx,
          ty,
        });
      },
      [containerH, containerW, scale, tx, ty],
    );

    useEffect(() => {
      if (!gpuInteractiveSrc) {
        setGpuInteractiveReady(false);
      }
    }, [gpuInteractiveSrc]);

    const shouldApproximateWithGpu = canUseGpuInteractivePreview && approximateFilterWithGpu;

    useEffect(() => {
      setLoadedMainSrc(null);
    }, [focusedId]);

    useEffect(() => {
      // 预设/白平衡这类一次性操作先展示 GPU 近似效果，再延迟进入后端 settled 渲染。
      if (filterInteraction !== "preset_applied") return;
      const handle = setTimeout(() => setFilterInteraction("settling"), 450);
      return () => clearTimeout(handle);
    }, [filterInteraction, setFilterInteraction]);

    const bind = usePreviewGestures({
      viewportRef,
      fitScale,
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
      toSourceCoordinate,
      setFilter,
      setEyedropperMode,
    });

    const wmDims = focused
      ? watermarkDimensions({
          baselinePreview: focusedBaselinePreview,
          focused,
          preview: currentPreviewImage,
        })
      : null;

    useEffect(() => {
      if (!focusedId || !containerW || !containerH) return;
      const rect = containedImageRect({
        displayH: containerH,
        displayW: containerW,
        imgH: wmDims?.height,
        imgW: wmDims?.width,
      });
      setWatermarkPreviewSize({ width: rect.width, height: rect.height }, focusedId);
    }, [containerH, containerW, focusedId, setWatermarkPreviewSize, wmDims?.height, wmDims?.width]);

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
      displayOrientation,
      originalSrc,
      previewSrc,
      showingOriginal,
      showGpuInteractiveLayer,
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

    const showPlaceholder =
      !showingOriginal &&
      !showGpuInteractiveLayer &&
      (!displaySrc || loadedMainSrc !== displaySrc) &&
      !!focusedPlaceholder?.blobUrl;
    const showMainImage = !!displaySrc && imgVisible && !showingOriginal;
    const waitingForCurrentImage =
      !showingOriginal && !!displaySrc && loadedMainSrc !== displaySrc;
    const showTransitionFrame =
      !showingOriginal &&
      !!lastDisplayFrame &&
      ((waitingForCurrentImage && !showPlaceholder) ||
        (!displaySrc && !originalSrc && !showPlaceholder));
    const showRenderingBadge = loading && !showOriginal;
    const blurPlaceholder =
      loading &&
      !!focused?.is_raw &&
      !currentBaselinePreview &&
      !!focusedPlaceholder?.blobUrl;

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
              ) : displaySrc || originalSrc || showPlaceholder || showTransitionFrame ? (
                <>
                  {showTransitionFrame && lastDisplayFrame && (
                    <div
                      style={{
                        transform: `translate(${lastDisplayFrame.tx}px, ${lastDisplayFrame.ty}px) scale(${lastDisplayFrame.scale})`,
                        transformOrigin: "0 0",
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: lastDisplayFrame.containerW,
                        height: lastDisplayFrame.containerH,
                        lineHeight: 0,
                      }}
                    >
                      <OrientedImage
                        src={lastDisplayFrame.src}
                        alt=""
                        containerW={lastDisplayFrame.containerW}
                        containerH={lastDisplayFrame.containerH}
                        orientation={lastDisplayFrame.orientation}
                        objectFit="contain"
                        opacity={1}
                      />
                    </div>
                  )}
                  {(displaySrc || originalSrc || showPlaceholder) && (
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
                      {showPlaceholder && (
                        <OrientedImage
                          src={focusedPlaceholder.blobUrl}
                          alt=""
                          containerW={containerW}
                          containerH={containerH}
                          orientation={focusedPlaceholder.orientation}
                          objectFit="contain"
                          opacity={displaySrc && loadedMainSrc === displaySrc ? 0 : 1}
                          onLoad={() =>
                            rememberDisplayFrame(
                              focusedPlaceholder.blobUrl,
                              focusedPlaceholder.orientation,
                            )
                          }
                          style={
                            blurPlaceholder
                              ? {
                                  filter: "blur(14px) brightness(0.82)",
                                }
                              : undefined
                          }
                        />
                      )}
                      {displaySrc && (
                        <OrientedImage
                          src={displaySrc}
                          alt="preview"
                          containerW={containerW}
                          containerH={containerH}
                          orientation={displayOrientation}
                          objectFit="contain"
                          opacity={showMainImage ? 1 : 0}
                          onLoad={(e) => {
                            const el = e.currentTarget as HTMLImageElement;
                            setLoadedMainSrc(displaySrc);
                            rememberDisplayFrame(displaySrc, displayOrientation);
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
                            objectFit: "contain",
                            filter: "none",
                            opacity: 1,
                            transition: "none",
                          }}
                          draggable={false}
                          onLoad={() => rememberDisplayFrame(originalSrc, null)}
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
                      <TilePreviewOverlay
                        tilePreviews={tilePreviews}
                        assetId={focused.id}
                        displayWidth={containerW}
                        displayHeight={containerH}
                        sourceWidth={sourceCoordinateSize.width}
                        sourceHeight={sourceCoordinateSize.height}
                      />
                      {!showOriginal && watermark.enabled && wmDims && (
                        <WatermarkOverlay
                          displayW={containerW}
                          displayH={containerH}
                          wm={watermark}
                          imgW={wmDims.width}
                          imgH={wmDims.height}
                        />
                      )}
                    </div>
                  )}
                </>
              ) : null}
            </>
          )}
          {!!focused.width && !!focused.height && displaySrc && (
            <div className="absolute bottom-3 right-3 text-[10px] text-zinc-500 bg-zinc-950/60 px-2 py-1 rounded">
              {focused.width} × {focused.height} ·{" "}
              {formatBytes(focused.file_size)}
            </div>
          )}
          {showRenderingBadge && (
            <div className="pointer-events-none absolute left-3 top-3 z-20 inline-flex h-6 items-center rounded bg-zinc-950/55 px-2.5 text-[11px] leading-none text-zinc-200 shadow-sm backdrop-blur-sm">
              {loadingMode === "full"
                ? t("previewPanel.loadingOriginal")
                : t("previewPanel.rendering")}
            </div>
          )}
        </div>
      </main>
    );
  },
);

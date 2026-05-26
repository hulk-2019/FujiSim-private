import { useEffect, useLayoutEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon } from "lucide-react";
import { useGesture } from "@use-gesture/react";
import { api } from "@/api";
import type { WatermarkSettings } from "@/types";
import { useStore } from "@/store";
import { formatBytes } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { renderWatermarkLayer } from "@/lib/watermarkCanvas";

let previewTokenCounter = 0;

const MIN_SCALE = 0.05;        // 绝对最小缩放比例 5%
const MAX_SCALE_FACTOR = 10;   // 相对 fit scale 的最大倍率
const MAX_SCALE_ABSOLUTE = 4;  // 绝对最大缩放（400%），保证小图也能放到 4x
const FIT_FILL = 0.8;

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
  const focused = assets.find((a) => a?.id === focusedId) ?? null;

  const [preview, setPreview] = useState<{
    blobUrl: string;
    width: number;
    height: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawOriginalSrc, setRawOriginalSrc] = useState<string | null>(null);
  const currentTokenRef = useRef(0);

  const [scale, setScale] = useState<number>(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);
  // 隐藏图片直到 fit 计算完成，避免切换时闪烁到左上角
  const [imgVisible, setImgVisible] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // 防止全分辨率预览替换缩略图时重复 fit
  const hasFitRef = useRef(false);
  const fitScaleRef = useRef(1);

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
    const vp = viewportRef.current;
    if (!vp) return;
    const vpW = vp.clientWidth;
    const vpH = vp.clientHeight;
    setScale((prev) => {
      if (prev <= 0) return next;
      const ratio = next / prev;
      setTx((prevTx) => vpW / 2 - ratio * (vpW / 2 - prevTx));
      setTy((prevTy) => vpH / 2 - ratio * (vpH / 2 - prevTy));
      return next;
    });
  }, []);

  useImperativeHandle(ref, () => ({
    fitToView: resetToFit,
    setZoomLevel,
  }), [resetToFit, setZoomLevel]);

  // scale / fit 变化时上报
  useEffect(() => {
    onScaleChange?.(scale, fitScaleRef.current);
  }, [scale, onScaleChange]);

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
      setLoading(false);
      return;
    }

    const token = ++previewTokenCounter;
    currentTokenRef.current = token;

    // When resetting to identity, clear the preview immediately so the canvas
    // shows the original instead of the old effect.
    // For normal adjustments, keep the old preview visible until new one arrives.
    const isIdentity =
      (filter.base_simulation === "Pass-Through" || !filter.base_simulation) &&
      !filter.lut_file_path &&
      filter.exposure === 0 &&
      filter.contrast === 0 &&
      filter.brightness === 0 &&
      filter.highlight_tone === 0 &&
      filter.shadow_tone === 0 &&
      filter.white === 0 &&
      filter.black === 0 &&
      filter.dehaze === 0 &&
      filter.vibrance === 0 &&
      filter.color_saturation === 0 &&
      filter.clarity === 0 &&
      filter.sharpness === 0 &&
      filter.wb_shift_r === 0 &&
      filter.wb_shift_b === 0 &&
      filter.grain_amount === 0 &&
      filter.hsl_red_hue === 0 &&
      filter.hsl_red_sat === 0 &&
      filter.hsl_red_lum === 0 &&
      filter.hsl_orange_hue === 0 &&
      filter.hsl_orange_sat === 0 &&
      filter.hsl_orange_lum === 0 &&
      filter.hsl_yellow_hue === 0 &&
      filter.hsl_yellow_sat === 0 &&
      filter.hsl_yellow_lum === 0 &&
      filter.hsl_green_hue === 0 &&
      filter.hsl_green_sat === 0 &&
      filter.hsl_green_lum === 0 &&
      filter.hsl_aqua_hue === 0 &&
      filter.hsl_aqua_sat === 0 &&
      filter.hsl_aqua_lum === 0 &&
      filter.hsl_blue_hue === 0 &&
      filter.hsl_blue_sat === 0 &&
      filter.hsl_blue_lum === 0 &&
      filter.hsl_purple_hue === 0 &&
      filter.hsl_purple_sat === 0 &&
      filter.hsl_purple_lum === 0 &&
      filter.hsl_magenta_hue === 0 &&
      filter.hsl_magenta_sat === 0 &&
      filter.hsl_magenta_lum === 0 &&
      (!filter.tone_curve || (
        filter.tone_curve.rgb.length === 0 &&
        filter.tone_curve.r.length === 0 &&
        filter.tone_curve.g.length === 0 &&
        filter.tone_curve.b.length === 0
      ));

    if (isIdentity) {
      setPreview(null);
    }
    setError(null);
    setLoading(true);

    const handle = setTimeout(async () => {
      const isIdentity =
        (filter.base_simulation === "Pass-Through" || !filter.base_simulation) &&
        !filter.lut_file_path &&
        filter.exposure === 0 &&
        filter.contrast === 0 &&
        filter.brightness === 0 &&
        filter.highlight_tone === 0 &&
        filter.shadow_tone === 0 &&
        filter.white === 0 &&
        filter.black === 0 &&
        filter.dehaze === 0 &&
        filter.vibrance === 0 &&
        filter.color_saturation === 0 &&
        filter.clarity === 0 &&
        filter.sharpness === 0 &&
        filter.wb_shift_r === 0 &&
        filter.wb_shift_b === 0 &&
        filter.grain_amount === 0 &&
        filter.hsl_red_hue === 0 &&
        filter.hsl_red_sat === 0 &&
        filter.hsl_red_lum === 0 &&
        filter.hsl_orange_hue === 0 &&
        filter.hsl_orange_sat === 0 &&
        filter.hsl_orange_lum === 0 &&
        filter.hsl_yellow_hue === 0 &&
        filter.hsl_yellow_sat === 0 &&
        filter.hsl_yellow_lum === 0 &&
        filter.hsl_green_hue === 0 &&
        filter.hsl_green_sat === 0 &&
        filter.hsl_green_lum === 0 &&
        filter.hsl_aqua_hue === 0 &&
        filter.hsl_aqua_sat === 0 &&
        filter.hsl_aqua_lum === 0 &&
        filter.hsl_blue_hue === 0 &&
        filter.hsl_blue_sat === 0 &&
        filter.hsl_blue_lum === 0 &&
        filter.hsl_purple_hue === 0 &&
        filter.hsl_purple_sat === 0 &&
        filter.hsl_purple_lum === 0 &&
        filter.hsl_magenta_hue === 0 &&
        filter.hsl_magenta_sat === 0 &&
        filter.hsl_magenta_lum === 0 &&
        (!filter.tone_curve || (
          filter.tone_curve.rgb.length === 0 &&
          filter.tone_curve.r.length === 0 &&
          filter.tone_curve.g.length === 0 &&
          filter.tone_curve.b.length === 0
        ));

      if (currentTokenRef.current !== token) return;

      if (isIdentity && focused.is_raw) {
        setLoading(false);
        return;
      }

      const doPreview = async () => {
        const r = await api.getPreview(focused.id, filter, 1920, token);
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
  }, [focused?.id, filter]);

  // Clear preview when switching to a different photo, so old effect doesn't persist.
  useEffect(() => {
    setPreview(null);
    setRawOriginalSrc(null);
  }, [focused?.id]);

  // 切换素材时拉取 RAW 嵌入原图。声明顺序故意放在 getPreview effect 之后，
  // 这样 currentTokenRef 已是最新 token，避免与 getPreview 在 backend 端的
  // preview_token 上互相覆盖。失败时尝试用最新 token 再请求一次。
  useEffect(() => {
    if (!focused?.is_raw) {
      setRawOriginalSrc(null);
      return;
    }
    // 切到新 RAW 时先清空旧 URL，否则 loading 占位条件 (!rawOriginalSrc) 一直为 false，
    // 用户会在加载新图期间看到旧图，loading 动画也不会显示。
    setRawOriginalSrc(null);
    let cancelled = false;
    const tryFetch = async (token: number, attempt: number) => {
      try {
        const path = await api.getRawOriginal(focused.id, token);
        if (cancelled) return;
        setRawOriginalSrc(convertFileSrc(path));
      } catch (e) {
        if (cancelled) return;
        const msg = String(e);
        if (msg.includes("preview_cancelled") && attempt < 1) {
          await new Promise((r) => setTimeout(r, 300));
          if (cancelled) return;
          tryFetch(currentTokenRef.current, attempt + 1);
          return;
        }
        if (!msg.includes("preview_cancelled")) {
          setError(msg);
        }
      }
    };
    tryFetch(currentTokenRef.current, 0);
    return () => { cancelled = true; };
  }, [focused?.id, focused?.is_raw]);

  const bind = useGesture(
    {
      onWheel: ({ delta: [, dy], event }) => {
        event.preventDefault();
        const vp = viewportRef.current;
        if (!vp) return;
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
      onDoubleClick: () => resetToFit(),
    },
    {
      wheel: { eventOptions: { passive: false } },
      drag: { filterTaps: true, eventOptions: { passive: false } },
    },
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

  const previewSrc = preview?.blobUrl ?? null;
  const originalSrc = focused.is_raw ? rawOriginalSrc : convertFileSrc(focused.file_path);

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

  const wmDims: { width: number; height: number } | null = (() => {
    if (focused.width && focused.height) return { width: focused.width, height: focused.height };
    if (preview?.width && preview?.height) return { width: preview.width, height: preview.height };
    const nw = imgRef.current?.naturalWidth;
    const nh = imgRef.current?.naturalHeight;
    if (nw && nh) return { width: nw, height: nh };
    return null;
  })();

  return (
    <main className="w-full h-full flex flex-col bg-transparent min-w-0">
      <div
        ref={viewportRef}
        className="flex-1 relative overflow-hidden bg-zinc-950/20 cursor-grab active:cursor-grabbing"
        {...bind()}
        style={{ touchAction: "none" }}
      >
        {scale !== null && (
          <>
            {error ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-zinc-400 text-sm bg-zinc-900/80 px-4 py-2 rounded border border-zinc-800">
                  {error}
                </div>
              </div>
            ) : displaySrc || originalSrc ? (
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
                  visibility: imgVisible ? "visible" : "hidden",
                }}
              >
                {displaySrc && (
                  <img
                    ref={imgRef}
                    src={displaySrc}
                    alt="preview"
                    style={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                      opacity: imgVisible && !showOriginal ? 1 : 0,
                      WebkitUserSelect: "none",
                      WebkitTouchCallout: "none",
                    }}
                    draggable={false}
                    onLoad={(e) => {
                      const el = e.currentTarget as HTMLImageElement;
                      console.log("[PreviewPanel] onLoad", el.src, el.naturalWidth, "x", el.naturalHeight);
                      if (previewSrc || rawOriginalSrc) {
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
                {originalSrc && showOriginal && (
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
                {!showOriginal && watermark.enabled && wmDims && (
                  <WatermarkOverlay
                    wm={watermark}
                    imgW={wmDims.width}
                    imgH={wmDims.height}
                  />
                )}
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex flex-col items-center justify-center gap-3 text-zinc-500">
                  <div className="relative w-10 h-10">
                    <div className="absolute inset-0 rounded-full border-2 border-zinc-600 animate-ping opacity-60" />
                    <div className="absolute inset-1.5 rounded-full bg-zinc-600 animate-pulse" />
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        {loading && displaySrc && (
          <div className="absolute top-3 left-3 text-xs text-zinc-400 bg-zinc-950/60 px-2 py-1 rounded">
            {t("previewPanel.rendering")}
          </div>
        )}
        {!!focused.is_raw && !rawOriginalSrc && !error && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="relative w-10 h-10">
              <div className="absolute inset-0 rounded-full border-2 border-zinc-300 animate-ping opacity-70" />
              <div className="absolute inset-1.5 rounded-full bg-zinc-300 animate-pulse" />
            </div>
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

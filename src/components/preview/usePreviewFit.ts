import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Asset } from "@/types";

const FIT_FILL = 0.8;

/**
 * 统一管理预览图在画布中的几何状态。
 *
 * PreviewPanel 只关心“当前怎么画”，这里负责：
 * - fit-to-view 初始布局；
 * - 平移/缩放状态；
 * - 切换素材时先隐藏图片，避免新图以旧 transform 闪一帧；
 * - 记录 fitScale，供外部缩放控件判断当前倍率。
 */
export function usePreviewFit({
  focused,
  imgRef,
  onScaleChange,
  viewportRef,
}: {
  focused: Asset | null;
  imgRef: RefObject<HTMLImageElement>;
  onScaleChange?: (scale: number, fitScale: number) => void;
  viewportRef: RefObject<HTMLDivElement>;
}) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);
  const [imgVisible, setImgVisible] = useState(false);
  const fitScaleRef = useRef(1);
  // 全分辨率图替换低分辨率图时，不能重复执行 fit，否则用户当前缩放会被重置。
  const hasFitRef = useRef(false);

  const applyFit = useCallback(
    (imgW: number, imgH: number, reveal: boolean) => {
      const vp = viewportRef.current;
      if (!vp || !imgW || !imgH) return false;
      const vpW = vp.clientWidth;
      const vpH = vp.clientHeight;
      const fit = Math.min(vpW / imgW, vpH / imgH) * FIT_FILL;
      fitScaleRef.current = fit;
      setContainerW(imgW);
      setContainerH(imgH);
      setScale(fit);
      setTx((vpW - imgW * fit) / 2);
      setTy((vpH - imgH * fit) / 2);
      if (reveal) setImgVisible(true);
      return true;
    },
    [viewportRef],
  );

  // 图片 EXIF 尺寸缺失时，等 <img> 加载完成后用 naturalWidth/Height 兜底。
  const resetToFit = useCallback(() => {
    const img = imgRef.current;
    const imgW = focused?.width || img?.naturalWidth || 0;
    const imgH = focused?.height || img?.naturalHeight || 0;
    applyFit(imgW, imgH, true);
  }, [applyFit, focused?.height, focused?.width, imgRef]);

  useEffect(() => {
    onScaleChange?.(scale, fitScaleRef.current);
  }, [onScaleChange, scale]);

  useLayoutEffect(() => {
    hasFitRef.current = false;
    setImgVisible(false);

    if (!focused?.width || !focused.height) {
      // 没有尺寸时先不做布局，留给图片 onLoad 后的 resetToFit 处理。
      fitScaleRef.current = 1;
      return;
    }
    applyFit(focused.width, focused.height, false);
  }, [applyFit, focused?.height, focused?.id, focused?.width]);

  return {
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
  };
}

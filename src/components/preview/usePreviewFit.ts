import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
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
  onScaleChange,
  viewportRef,
}: {
  focused: Asset | null;
  onScaleChange?: (scale: number, fitScale: number) => void;
  viewportRef: React.RefObject<HTMLDivElement>;
}) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);
  const [imgVisible, setImgVisible] = useState(false);
  const [fitScale, setFitScale] = useState(1);

  const applyFit = useCallback(
    (imgW: number, imgH: number) => {
      const vp = viewportRef.current;
      if (!vp || !imgW || !imgH) return false;
      const vpW = vp.clientWidth;
      const vpH = vp.clientHeight;
      const fit = Math.min(vpW / imgW, vpH / imgH) * FIT_FILL;
      setFitScale(fit);
      setContainerW(imgW);
      setContainerH(imgH);
      setScale(fit);
      setTx((vpW - imgW * fit) / 2);
      setTy((vpH - imgH * fit) / 2);
      setImgVisible(true);
      return true;
    },
    [viewportRef],
  );

  const resetToFit = useCallback(() => {
    return applyFit(focused?.width || 0, focused?.height || 0);
  }, [applyFit, focused?.height, focused?.width]);

  useEffect(() => {
    onScaleChange?.(scale, fitScale);
  }, [fitScale, onScaleChange, scale]);

  useLayoutEffect(() => {
    setImgVisible(false);

    if (!focused?.width || !focused.height) {
      setFitScale(1);
      setContainerW(0);
      setContainerH(0);
      return;
    }
    applyFit(focused.width, focused.height);
  }, [applyFit, focused?.height, focused?.id, focused?.width]);

  return {
    containerH,
    containerW,
    fitScale,
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

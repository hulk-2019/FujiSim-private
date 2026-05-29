import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useGesture } from "@use-gesture/react";

const MIN_SCALE = 0.05;
const MAX_SCALE_FACTOR = 10;
const MAX_SCALE_ABSOLUTE = 4;

export function usePreviewGestures({
  viewportRef,
  fitScale,
  markZooming,
  resetToFit,
  setScale,
  setTx,
  setTy,
}: {
  viewportRef: RefObject<HTMLDivElement>;
  fitScale: number;
  markZooming: () => void;
  resetToFit: () => void;
  setScale: Dispatch<SetStateAction<number>>;
  setTx: Dispatch<SetStateAction<number>>;
  setTy: Dispatch<SetStateAction<number>>;
}) {
  return useGesture(
    {
      onWheel: ({ delta: [, dy], event }) => {
        event.preventDefault();
        const vp = viewportRef.current;
        if (!vp) return;
        markZooming();
        const rect = vp.getBoundingClientRect();
        const mouseX = (event as WheelEvent).clientX - rect.left;
        const mouseY = (event as WheelEvent).clientY - rect.top;

        setScale((prevScale) => {
          const factor = Math.pow(0.999, dy);
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
        markZooming();
        resetToFit();
      },
    },
    {
      wheel: { eventOptions: { passive: false } },
      drag: { filterTaps: true, eventOptions: { passive: false } },
    },
  );
}

export function useZoomToLevel({
  viewportRef,
  markZooming,
  setScale,
  setTx,
  setTy,
}: {
  viewportRef: RefObject<HTMLDivElement>;
  markZooming: () => void;
  setScale: Dispatch<SetStateAction<number>>;
  setTx: Dispatch<SetStateAction<number>>;
  setTy: Dispatch<SetStateAction<number>>;
}) {
  return useCallback((next: number) => {
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
  }, [markZooming, setScale, setTx, setTy, viewportRef]);
}

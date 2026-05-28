import { useEffect, useMemo, useState } from "react";
import {
  FULL_RESOLUTION_PREVIEW_OVERSAMPLE,
  SETTLED_PREVIEW_MAX_EDGE,
} from "./previewRequest";

const ZOOM_SETTLE_DELAY_MS = 180;

export function useFullResolutionPreviewTrigger({
  nativeWidth,
  nativeHeight,
  scale,
  isAdjustingFilter,
}: {
  nativeWidth?: number | null;
  nativeHeight?: number | null;
  scale: number;
  isAdjustingFilter: boolean;
}) {
  const [zoomSettled, setZoomSettled] = useState(true);

  useEffect(() => {
    setZoomSettled(false);
    const handle = setTimeout(() => setZoomSettled(true), ZOOM_SETTLE_DELAY_MS);
    return () => clearTimeout(handle);
  }, [scale]);

  const threshold = useMemo(() => {
    const nativeMaxEdge = Math.max(nativeWidth ?? 0, nativeHeight ?? 0);
    if (nativeMaxEdge <= SETTLED_PREVIEW_MAX_EDGE) {
      return Number.POSITIVE_INFINITY;
    }

    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    return (
      (SETTLED_PREVIEW_MAX_EDGE * FULL_RESOLUTION_PREVIEW_OVERSAMPLE) /
      (nativeMaxEdge * dpr)
    );
  }, [nativeHeight, nativeWidth]);

  return {
    threshold,
    useFullResolutionPreview:
      !isAdjustingFilter && zoomSettled && scale >= threshold,
  };
}

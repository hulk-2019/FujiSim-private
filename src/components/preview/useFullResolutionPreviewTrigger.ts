import { useEffect, useMemo, useState } from "react";
import type { FilterSettings } from "@/types";
import {
  FULL_RESOLUTION_PREVIEW_OVERSAMPLE,
  SETTLED_PREVIEW_MAX_EDGE,
} from "./previewRequest";

const ZOOM_SETTLE_DELAY_MS = 180;
const FILTER_SETTLE_DELAY_MS = 1100;

export function useFullResolutionPreviewTrigger({
  nativeWidth,
  nativeHeight,
  scale,
  filter,
  isAdjustingFilter,
}: {
  nativeWidth?: number | null;
  nativeHeight?: number | null;
  scale: number;
  filter: FilterSettings;
  isAdjustingFilter: boolean;
}) {
  const [zoomSettled, setZoomSettled] = useState(true);
  const [filterSettled, setFilterSettled] = useState(true);

  useEffect(() => {
    setZoomSettled(false);
    const handle = setTimeout(() => setZoomSettled(true), ZOOM_SETTLE_DELAY_MS);
    return () => clearTimeout(handle);
  }, [scale]);

  useEffect(() => {
    setFilterSettled(false);
    const handle = setTimeout(() => setFilterSettled(true), FILTER_SETTLE_DELAY_MS);
    return () => clearTimeout(handle);
  }, [filter]);

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
      !isAdjustingFilter && zoomSettled && filterSettled && scale >= threshold,
  };
}

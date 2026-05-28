import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api";
import type { Asset, FilterSettings, PreviewMode } from "@/types";
import { previewResultToImage, revokePreviewImage, type AssetPreviewImage, type PreviewImage } from "./previewImages";
import {
  INTERACTIVE_PREVIEW_DELAY_MS,
  INTERACTIVE_PREVIEW_MAX_EDGE,
  SETTLED_PREVIEW_DELAY_MS,
  SETTLED_PREVIEW_MAX_EDGE,
  nextPreviewToken,
} from "./previewRequest";

function previewRequestSpec(
  isAdjustingFilter: boolean,
  useFullResolutionPreview: boolean,
): { mode: PreviewMode; maxEdge?: number } {
  if (useFullResolutionPreview) return { mode: "full" };
  if (isAdjustingFilter) {
    return { mode: "interactive", maxEdge: INTERACTIVE_PREVIEW_MAX_EDGE };
  }
  return { mode: "settled", maxEdge: SETTLED_PREVIEW_MAX_EDGE };
}

export function usePreviewLoader({
  focused,
  filter,
  isIdentity,
  isAdjustingFilter,
  showOriginal,
  canUseGpuInteractivePreview,
  useFullResolutionPreview,
  setPreviewSize,
}: {
  focused: Asset | null;
  filter: FilterSettings;
  isIdentity: boolean;
  isAdjustingFilter: boolean;
  showOriginal: boolean;
  canUseGpuInteractivePreview: boolean;
  useFullResolutionPreview: boolean;
  setPreviewSize: (size: { width: number; height: number }, assetId?: number) => void;
}) {
  const [preview, setPreview] = useState<AssetPreviewImage | null>(null);
  const [baselinePreviews, setBaselinePreviews] = useState<Record<number, PreviewImage>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestTick, setRequestTick] = useState(0);
  const loadingRef = useRef(false);
  const currentTokenRef = useRef(0);
  const inFlightRef = useRef(false);
  const pendingTokenRef = useRef<number | null>(null);
  const previewRef = useRef<AssetPreviewImage | null>(null);
  const baselineRef = useRef<Record<number, PreviewImage>>({});
  const resolvedBaseRef = useRef<Set<number>>(new Set());

  const setPreviewLoading = useCallback((next: boolean) => {
    loadingRef.current = next;
    setLoading(next);
  }, []);

  const { mode, maxEdge } = previewRequestSpec(isAdjustingFilter, useFullResolutionPreview);
  const requestKey = `${mode}:${maxEdge ?? "native"}`;

  useEffect(() => {
    if (!focused) {
      pendingTokenRef.current = null;
      revokePreviewImage(previewRef.current);
      previewRef.current = null;
      setPreview(null);
      setPreviewLoading(false);
      return;
    }

    const token = nextPreviewToken();
    currentTokenRef.current = token;

    if (isIdentity && !useFullResolutionPreview) {
      pendingTokenRef.current = null;
      revokePreviewImage(previewRef.current);
      previewRef.current = null;
      setPreview(null);
      setPreviewLoading(false);
      if (baselineRef.current[focused.id] || !focused.is_raw) return;
    }

    setError(null);
    const hasDisplay = focused.is_raw
      ? !!previewRef.current || !!baselineRef.current[focused.id] || resolvedBaseRef.current.has(focused.id)
      : true;
    setPreviewLoading(false);

    if (focused.is_raw && !hasDisplay) {
      api.hasPreviewBase(focused.id)
        .then((hasBase) => {
          if (currentTokenRef.current !== token) return;
          if (hasBase) resolvedBaseRef.current.add(focused.id);
          else setPreviewLoading(true);
        })
        .catch(() => {
          if (currentTokenRef.current === token) setPreviewLoading(true);
        });
    }

    if (canUseGpuInteractivePreview && !!baselineRef.current[focused.id]) {
      pendingTokenRef.current = null;
      return;
    }

    if (inFlightRef.current) {
      pendingTokenRef.current = token;
      return;
    }

    const delay = !hasDisplay ? 0 : isAdjustingFilter ? INTERACTIVE_PREVIEW_DELAY_MS : SETTLED_PREVIEW_DELAY_MS;

    const handle = setTimeout(async () => {
      if (currentTokenRef.current !== token) return;
      inFlightRef.current = true;
      try {
        const result = await api.getPreview(focused.id, filter, mode, maxEdge, token);
        if (currentTokenRef.current !== token) return;
        const nextImage = previewResultToImage(result);
        if (isIdentity && !useFullResolutionPreview) {
          setBaselinePreviews((prev) => {
            revokePreviewImage(prev[focused.id]);
            const next = { ...prev, [focused.id]: nextImage };
            baselineRef.current = next;
            return next;
          });
          resolvedBaseRef.current.add(focused.id);
          revokePreviewImage(previewRef.current);
          previewRef.current = null;
          setPreview(null);
        } else {
          const nextPreview = { assetId: focused.id, ...nextImage };
          revokePreviewImage(previewRef.current);
          previewRef.current = nextPreview;
          setPreview(nextPreview);
        }
        setPreviewSize({ width: result.width, height: result.height }, focused.id);
        setPreviewLoading(false);
      } catch (e) {
        if (currentTokenRef.current !== token || String(e).includes("preview_cancelled")) return;
        if (String(e).includes("preview_busy")) pendingTokenRef.current = token;
        else {
          setError(String(e));
          setPreviewLoading(false);
        }
      } finally {
        inFlightRef.current = false;
        if (
          pendingTokenRef.current !== null &&
          pendingTokenRef.current === currentTokenRef.current
        ) {
          pendingTokenRef.current = null;
          setRequestTick((v) => v + 1);
        }
      }
    }, delay);

    return () => clearTimeout(handle);
  }, [focused?.id, filter, isIdentity, isAdjustingFilter, canUseGpuInteractivePreview, showOriginal, useFullResolutionPreview, requestKey, requestTick, setPreviewLoading, setPreviewSize]);

  useEffect(() => {
    revokePreviewImage(previewRef.current);
    previewRef.current = null;
    setPreview(null);
  }, [focused?.id]);

  useEffect(() => {
    return () => {
      revokePreviewImage(previewRef.current);
      Object.values(baselineRef.current).forEach(revokePreviewImage);
    };
  }, []);

  return { preview, baselinePreviews, loading, loadingRef, error };
}

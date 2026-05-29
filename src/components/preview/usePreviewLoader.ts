import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api";
import type { Asset, FilterSettings, PreviewMode } from "@/types";
import type { FilterSlice } from "@/store/types";
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
  filterInteraction,
  showOriginal,
  canUseGpuInteractivePreview,
  useFullResolutionPreview,
  projectId,
  setPreviewSize,
}: {
  focused: Asset | null;
  filter: FilterSettings;
  isIdentity: boolean;
  isAdjustingFilter: boolean;
  filterInteraction: FilterSlice["filterInteraction"];
  showOriginal: boolean;
  canUseGpuInteractivePreview: boolean;
  useFullResolutionPreview: boolean;
  projectId?: number | null;
  setPreviewSize: (size: { width: number; height: number }, assetId?: number) => void;
}) {
  const [preview, setPreview] = useState<AssetPreviewImage | null>(null);
  const [baselinePreviews, setBaselinePreviews] = useState<Record<number, PreviewImage>>({});
  const [placeholders, setPlaceholders] = useState<Record<number, PreviewImage>>({});
  const [loading, setLoading] = useState(false);
  const [loadingMode, setLoadingMode] = useState<PreviewMode | null>(null);
  const [initializingBase, setInitializingBase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestTick, setRequestTick] = useState(0);
  const loadingRef = useRef(false);
  const currentTokenRef = useRef(0);
  const inFlightRef = useRef(false);
  const inFlightRequestRef = useRef<string | null>(null);
  const pendingRequestRef = useRef<string | null>(null);
  const completedRequestRef = useRef<string | null>(null);
  const previewRef = useRef<AssetPreviewImage | null>(null);
  const baselineRef = useRef<Record<number, PreviewImage>>({});
  const placeholderRef = useRef<Record<number, PreviewImage>>({});
  const fastPreviewFailedRef = useRef<Set<number>>(new Set());

  const setPreviewLoading = useCallback((next: boolean, nextMode: PreviewMode | null = null) => {
    loadingRef.current = next;
    setLoading(next);
    setLoadingMode(next ? nextMode : null);
  }, []);

  const { mode, maxEdge } = previewRequestSpec(isAdjustingFilter, useFullResolutionPreview);
  const requestKey = `${mode}:${maxEdge ?? "native"}`;
  const renderPhase = filterInteraction === "preset_applied" ? "gpu_only" : "render";
  const requestSignature = focused
    ? JSON.stringify({
        assetId: focused.id,
        filter,
        isIdentity,
        maxEdge: maxEdge ?? null,
        mode,
        projectId: projectId ?? null,
        useFullResolutionPreview,
      })
    : "";

  useEffect(() => {
    if (!focused) {
      pendingRequestRef.current = null;
      inFlightRequestRef.current = null;
      completedRequestRef.current = null;
      revokePreviewImage(previewRef.current);
      previewRef.current = null;
      setPreview(null);
      setPreviewLoading(false);
      setInitializingBase(false);
      return;
    }

    if (isIdentity && !useFullResolutionPreview) {
      pendingRequestRef.current = null;
      revokePreviewImage(previewRef.current);
      previewRef.current = null;
      setPreview(null);
      setPreviewLoading(false);
      setInitializingBase(false);
      if (!focused.is_raw && baselineRef.current[focused.id]) return;
    }

    setError(null);
    const hasPlaceholder = !!placeholderRef.current[focused.id];
    const hasDisplay = focused.is_raw
      ? !!previewRef.current || !!baselineRef.current[focused.id] || hasPlaceholder
      : true;
    setInitializingBase(Boolean(focused.is_raw && !hasDisplay));

    if (
      focused.is_raw &&
      !hasDisplay &&
      !useFullResolutionPreview &&
      !fastPreviewFailedRef.current.has(focused.id)
    ) {
      const fastToken = nextPreviewToken();
      currentTokenRef.current = fastToken;
      setPreviewLoading(true, "interactive");
      api.getFastPreview(focused.id, SETTLED_PREVIEW_MAX_EDGE, fastToken)
        .then((result) => {
          if (currentTokenRef.current !== fastToken) return;
          const fastImage = previewResultToImage(result);
          setPlaceholders((prev) => {
            revokePreviewImage(prev[focused.id]);
            const next = { ...prev, [focused.id]: fastImage };
            placeholderRef.current = next;
            return next;
          });
          setPreviewSize({ width: result.width, height: result.height }, focused.id);
          setInitializingBase(false);
          setPreviewLoading(false);
          setRequestTick((v) => v + 1);
        })
        .catch((e) => {
          const message = String(e);
          if (currentTokenRef.current === fastToken && !message.includes("preview_cancelled")) {
            fastPreviewFailedRef.current.add(focused.id);
          }
          if (currentTokenRef.current === fastToken) {
            setPreviewLoading(false);
            setRequestTick((v) => v + 1);
          }
        });
      return;
    }

    const shouldUseGpuOnly =
      canUseGpuInteractivePreview &&
      (isAdjustingFilter || renderPhase === "gpu_only") &&
      !!baselineRef.current[focused.id];

    if (shouldUseGpuOnly) {
      pendingRequestRef.current = null;
      setPreviewLoading(false);
      return;
    }

    if (completedRequestRef.current === requestSignature) {
      setPreviewLoading(false);
      return;
    }

    if (inFlightRef.current) {
      if (inFlightRequestRef.current === requestSignature) return;
      pendingRequestRef.current = requestSignature;
      currentTokenRef.current = nextPreviewToken();
      return;
    }

    const delay = !hasDisplay ? 0 : isAdjustingFilter ? INTERACTIVE_PREVIEW_DELAY_MS : SETTLED_PREVIEW_DELAY_MS;
    const token = nextPreviewToken();
    currentTokenRef.current = token;
    setPreviewLoading(false);

    const handle = setTimeout(async () => {
      if (currentTokenRef.current !== token) return;
      inFlightRef.current = true;
      inFlightRequestRef.current = requestSignature;
      setPreviewLoading(true, mode);
      try {
        const result = await api.getPreview(focused.id, filter, mode, maxEdge, token, null, projectId);
        if (currentTokenRef.current !== token) return;
        const nextImage = previewResultToImage(result);
        if (isIdentity && !useFullResolutionPreview) {
          setBaselinePreviews((prev) => {
            revokePreviewImage(prev[focused.id]);
            const next = { ...prev, [focused.id]: nextImage };
            baselineRef.current = next;
            return next;
          });
          setInitializingBase(false);
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
        completedRequestRef.current = requestSignature;
        setPreviewLoading(false);
      } catch (e) {
        const message = String(e);
        if (currentTokenRef.current !== token || message.includes("preview_cancelled")) {
          setPreviewLoading(false);
          return;
        }
        if (message.includes("preview_busy")) {
          pendingRequestRef.current = requestSignature;
          setPreviewLoading(false);
        } else {
          setError(message);
          setPreviewLoading(false);
        }
      } finally {
        inFlightRef.current = false;
        inFlightRequestRef.current = null;
        if (pendingRequestRef.current !== null) {
          pendingRequestRef.current = null;
          setRequestTick((v) => v + 1);
        }
      }
    }, delay);

    return () => clearTimeout(handle);
  }, [focused?.id, filter, isIdentity, isAdjustingFilter, renderPhase, canUseGpuInteractivePreview, showOriginal, useFullResolutionPreview, projectId, requestKey, requestSignature, requestTick, setPreviewLoading, setPreviewSize]);

  useEffect(() => {
    pendingRequestRef.current = null;
    inFlightRequestRef.current = null;
    completedRequestRef.current = null;
    revokePreviewImage(previewRef.current);
    previewRef.current = null;
    setPreview(null);
    setInitializingBase(false);
  }, [focused?.id]);

  useEffect(() => {
    return () => {
      revokePreviewImage(previewRef.current);
      Object.values(baselineRef.current).forEach(revokePreviewImage);
      Object.values(placeholderRef.current).forEach(revokePreviewImage);
    };
  }, []);

  return { preview, baselinePreviews, placeholders, loading, loadingMode, loadingRef, initializingBase, error };
}

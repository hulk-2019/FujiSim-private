import { useEffect, useRef } from "react";
import { api } from "@/api";
import { useStore } from "@/store";
import type { FilterSettings } from "@/types";

/**
 * 持续把当前 (focusedId, filter) 的直方图同步到 store。
 *
 * 与 PreviewPanel 的预览拉取解耦：
 * - 80ms trailing-edge throttle（直方图计算轻量，可比预览更激进）
 * - 独立 token，不与预览 token 互相误杀
 * - identity + RAW 也照常请求（修复历史 bug：之前会让直方图永远是 null）
 */
let histogramTokenCounter = 0;
const HISTOGRAM_MAX_RETRY = 6;

export function histogramErrorAction({
  currentToken,
  focusedId,
  message,
  requestFocusedId,
  requestToken,
  retryCount,
}: {
  currentToken: number;
  focusedId: number | null;
  message: string;
  requestFocusedId: number;
  requestToken: number;
  retryCount: number;
}): "ignore" | "retry" | "warn" {
  const currentRequest = currentToken === requestToken && focusedId === requestFocusedId;
  if (!currentRequest) return "ignore";
  if (
    (message.includes("preview_cancelled") || message.includes("preview_busy")) &&
    retryCount < HISTOGRAM_MAX_RETRY
  ) {
    return "retry";
  }
  if (message.includes("preview_cancelled") || message.includes("preview_busy")) return "ignore";
  return "warn";
}

export function useHistogramSync(
  focusedId: number | null,
  filter: FilterSettings,
): void {
  const setHistogram = useStore((s) => s.setHistogram);
  const isAdjustingFilter = useStore((s) => s.isAdjustingFilter);
  const currentTokenRef = useRef(0);
  const pendingHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedIdRef = useRef<number | null>(focusedId);

  useEffect(() => {
    focusedIdRef.current = focusedId;
    currentTokenRef.current = ++histogramTokenCounter;
    if (pendingHandle.current) {
      clearTimeout(pendingHandle.current);
      pendingHandle.current = null;
    }
    setHistogram(null);
  }, [focusedId, setHistogram]);

  useEffect(() => {
    if (!focusedId) {
      setHistogram(null);
      return;
    }

    if (pendingHandle.current) {
      clearTimeout(pendingHandle.current);
      pendingHandle.current = null;
    }
    currentTokenRef.current = ++histogramTokenCounter;

    if (isAdjustingFilter) {
      return;
    }

    const schedule = (delay: number, retryCount = 0) => {
      pendingHandle.current = setTimeout(async () => {
        if (focusedIdRef.current !== focusedId) return;
        const token = ++histogramTokenCounter;
        currentTokenRef.current = token;

        try {
          const data = await api.computeHistogram(focusedId, filter, token);
          if (currentTokenRef.current !== token || focusedIdRef.current !== focusedId) return;
          setHistogram(data);
        } catch (e) {
          const msg = String(e);
          const action = histogramErrorAction({
            currentToken: currentTokenRef.current,
            focusedId: focusedIdRef.current,
            message: msg,
            requestFocusedId: focusedId,
            requestToken: token,
            retryCount,
          });
          if (action === "retry") {
            schedule(220 + retryCount * 80, retryCount + 1);
            return;
          }
          if (action === "ignore") return;
          console.warn("[useHistogramSync] failed:", msg);
        }
      }, delay);
    };

    schedule(350);

    return () => {
      if (pendingHandle.current) {
        clearTimeout(pendingHandle.current);
        pendingHandle.current = null;
      }
    };
  }, [focusedId, filter, isAdjustingFilter, setHistogram]);
}

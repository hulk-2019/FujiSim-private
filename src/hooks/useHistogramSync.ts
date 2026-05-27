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

export function useHistogramSync(
  focusedId: number | null,
  filter: FilterSettings,
): void {
  const setHistogram = useStore((s) => s.setHistogram);
  const currentTokenRef = useRef(0);
  const pendingHandle = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!focusedId) {
      setHistogram(null);
      return;
    }

    if (pendingHandle.current) {
      clearTimeout(pendingHandle.current);
    }

    pendingHandle.current = setTimeout(async () => {
      const token = ++histogramTokenCounter;
      currentTokenRef.current = token;

      try {
        const data = await api.computeHistogram(focusedId, filter, token);
        if (currentTokenRef.current !== token) return;
        setHistogram(data);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("preview_cancelled") || msg.includes("preview_busy")) return;
        console.warn("[useHistogramSync] failed:", msg);
      }
    }, 80);

    return () => {
      if (pendingHandle.current) {
        clearTimeout(pendingHandle.current);
        pendingHandle.current = null;
      }
    };
  }, [focusedId, filter, setHistogram]);
}

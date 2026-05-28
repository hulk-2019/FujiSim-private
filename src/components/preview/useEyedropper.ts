import { useCallback, type RefObject } from "react";
import { api } from "@/api";
import { useStore } from "@/store";
import type { EyedropperMode } from "@/store/types";
import type { FilterSettings } from "@/types";

export function useEyedropper({
  focusedId,
  projectId,
  eyedropperMode,
  viewportRef,
  imageTransform,
  setFilter,
  setEyedropperMode,
}: {
  focusedId: number | null;
  projectId?: number | null;
  eyedropperMode: EyedropperMode;
  viewportRef: RefObject<HTMLDivElement>;
  imageTransform: {
    scale: number;
    tx: number;
    ty: number;
    width: number;
    height: number;
  };
  setFilter: (patch: Partial<FilterSettings>) => void;
  setEyedropperMode: (mode: EyedropperMode) => void;
}) {
  const setFilterInteraction = useStore((s) => s.setFilterInteraction);

  return useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      if (eyedropperMode === "none" || !focusedId) return;

      const viewport = viewportRef.current;
      const { scale, tx, ty, width, height } = imageTransform;
      if (!viewport || !scale || !width || !height) return;

      const rect = viewport.getBoundingClientRect();
      const imgX = Math.round((e.clientX - rect.left - tx) / scale);
      const imgY = Math.round((e.clientY - rect.top - ty) / scale);

      if (imgX < 0 || imgX >= width || imgY < 0 || imgY >= height) return;

      try {
        const { r, g, b } = await api.eyedropColor(focusedId, imgX, imgY, projectId);
        const avg = (r + g + b) / 3;
        if (avg < 1 || r < 1 || g < 1 || b < 1) return;
        setFilter({
          wb_shift_r: Math.round(Math.max(-100, Math.min(100, ((avg - r) / r) * 200))),
          wb_shift_g: Math.round(Math.max(-100, Math.min(100, ((avg - g) / g) * 200))),
          wb_shift_b: Math.round(Math.max(-100, Math.min(100, ((avg - b) / b) * 200))),
        });
        setFilterInteraction("preset_applied");
      } catch (err) {
        console.error("Eyedropper failed:", err);
      } finally {
        setEyedropperMode("none");
      }
    },
    [eyedropperMode, focusedId, imageTransform, projectId, setFilter, setEyedropperMode, setFilterInteraction, viewportRef],
  );
}

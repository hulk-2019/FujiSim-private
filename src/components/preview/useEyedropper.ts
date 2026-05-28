import { useCallback, type RefObject } from "react";
import { api } from "@/api";
import type { EyedropperMode } from "@/store/types";
import type { FilterSettings } from "@/types";

export function useEyedropper({
  focusedId,
  eyedropperMode,
  imgRef,
  setFilter,
  setEyedropperMode,
}: {
  focusedId: number | null;
  eyedropperMode: EyedropperMode;
  imgRef: RefObject<HTMLImageElement>;
  setFilter: (patch: Partial<FilterSettings>) => void;
  setEyedropperMode: (mode: EyedropperMode) => void;
}) {
  return useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      if (eyedropperMode === "none" || !focusedId) return;

      const img = imgRef.current;
      if (!img?.naturalWidth || !img.naturalHeight) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const imgAspect = img.naturalWidth / img.naturalHeight;
      const containerAspect = rect.width / rect.height;
      const renderedWidth = imgAspect > containerAspect ? rect.width : rect.height * imgAspect;
      const renderedHeight = imgAspect > containerAspect ? rect.width / imgAspect : rect.height;
      const offsetX = imgAspect > containerAspect ? 0 : (rect.width - renderedWidth) / 2;
      const offsetY = imgAspect > containerAspect ? (rect.height - renderedHeight) / 2 : 0;
      const imgX = Math.round(((e.clientX - rect.left - offsetX) / renderedWidth) * img.naturalWidth);
      const imgY = Math.round(((e.clientY - rect.top - offsetY) / renderedHeight) * img.naturalHeight);

      if (imgX < 0 || imgX >= img.naturalWidth || imgY < 0 || imgY >= img.naturalHeight) return;

      try {
        const { r, g, b } = await api.eyedropColor(focusedId, imgX, imgY);
        const avg = (r + g + b) / 3;
        if (avg < 1) return;
        setFilter({
          wb_shift_r: Math.round(Math.max(-100, Math.min(100, ((avg - r) / r) * 200))),
          wb_shift_g: Math.round(Math.max(-100, Math.min(100, ((avg - g) / g) * 200))),
          wb_shift_b: Math.round(Math.max(-100, Math.min(100, ((avg - b) / b) * 200))),
        });
      } catch (err) {
        console.error("Eyedropper failed:", err);
      } finally {
        setEyedropperMode("none");
      }
    },
    [eyedropperMode, focusedId, imgRef, setFilter, setEyedropperMode],
  );
}

import { useEffect } from "react";
import { api } from "@/api";
import type { FilterSettings } from "@/types";

type FilterInteraction = "idle" | "dragging" | "preset_applied" | "settling";

export function usePreviewInteractionMarker({
  filter,
  filterInteraction,
  isAdjustingFilter,
}: {
  filter: FilterSettings;
  filterInteraction: FilterInteraction;
  isAdjustingFilter: boolean;
}) {
  useEffect(() => {
    if (!isAdjustingFilter && filterInteraction !== "preset_applied") return;
    api.markPreviewInteraction(isAdjustingFilter ? 900 : 1400).catch(() => {});
  }, [filter, filterInteraction, isAdjustingFilter]);
}

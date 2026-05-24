import type { StateCreator } from "zustand";
import { api } from "../../api";
import type { AppState, FacetSlice } from "../types";

export const createFacetSlice: StateCreator<AppState, [], [], FacetSlice> = (set) => ({
  cameras: [],
  fujiSimulations: [
    "Provia", "Velvia", "Astia", "Classic Chrome",
    "Pro Neg Std", "Pro Neg Hi", "Eterna", "Classic Neg",
    "Nostalgic Neg", "Acros", "Acros + Y", "Acros + R", "Monochrome",
  ],

  refreshFacets: async () => {
    const [cams, sims] = await Promise.all([
      api.distinctCameras().catch(() => []),
      api.listFujiSimulations().catch(() => []),
    ]);
    set({ cameras: cams, fujiSimulations: sims });
  },
});

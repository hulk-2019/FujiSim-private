import type { StateCreator } from "zustand";
import { api } from "../../api";
import type { AppState, PresetSlice } from "../types";

export const createPresetSlice: StateCreator<AppState, [], [], PresetSlice> = (set) => ({
  presets: [],

  refreshPresets: async () => {
    const p = await api.listPresets().catch(() => []);
    set({ presets: p });
  },
});

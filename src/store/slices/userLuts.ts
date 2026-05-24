import type { StateCreator } from "zustand";
import { api } from "../../api";
import type { AppState, UserLutSlice } from "../types";

export const createUserLutSlice: StateCreator<AppState, [], [], UserLutSlice> = (set) => ({
  userLuts: [],

  refreshUserLuts: async () => {
    const luts = await api.listUserLuts().catch(() => []);
    set({ userLuts: luts });
  },
});

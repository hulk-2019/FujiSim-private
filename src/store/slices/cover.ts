import type { StateCreator } from "zustand";
import type { AppState, CoverSlice } from "../types";

export const createCoverSlice: StateCreator<AppState, [], [], CoverSlice> = (set) => ({
  coverDir: null,
  setCoverDir: (dir) => set({ coverDir: dir }),
});

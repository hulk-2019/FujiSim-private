import type { StateCreator } from "zustand";
import { api } from "../../api";
import { registerFont, unregisterFont } from "../../lib/fontManager";
import type { AppState, FontSlice } from "../types";

export const createFontSlice: StateCreator<AppState, [], [], FontSlice> = (set, get) => ({
  userFonts: [],

  addUserFont: async (paths) => {
    const imported = await api.importFonts(paths);
    await Promise.all(imported.map(registerFont));
    set({ userFonts: [...get().userFonts, ...imported] });
  },
  removeUserFont: async (id) => {
    await api.deleteUserFont(id);
    unregisterFont(id);
    set({ userFonts: get().userFonts.filter((f) => f.id !== id) });
  },
});

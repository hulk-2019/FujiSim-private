import type { StateCreator } from "zustand";
import { api } from "../../api";
import type { AppState, CategorySlice } from "../types";

export const createCategorySlice: StateCreator<AppState, [], [], CategorySlice> = (set, get) => ({
  categories: [],
  currentFolderId: null,
  currentFolderName: null,

  refreshCategories: async () => {
    const list = await api.listPresetCategories().catch(() => []);
    set({ categories: list });
  },
  createCategory: async (name: string) => {
    const created = await api.createPresetCategory(name);
    set({
      categories: [...get().categories, created].sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
      ),
    });
    return created;
  },
  renameCategory: async (id, name) => {
    const updated = await api.renamePresetCategory(id, name);
    set({
      categories: get().categories.map((c) => (c.id === id ? updated : c)),
    });
    return updated;
  },
  deleteCategory: async (id) => {
    await api.deletePresetCategory(id);
    set({ categories: get().categories.filter((c) => c.id !== id) });
    await Promise.all([get().refreshPresets(), get().refreshUserLuts()]);
  },
  setPresetCategory: async (presetId, categoryId) => {
    await api.setPresetCategory(presetId, categoryId);
    await get().refreshPresets();
  },
  setUserLutCategory: async (lutId, categoryId) => {
    await api.setUserLutCategory(lutId, categoryId);
    await get().refreshUserLuts();
  },

  enterFolder: async (id, name) => {
    set({ currentFolderId: id, currentFolderName: name });
    await get().setQuery({ album_id: id });
  },

  exitFolder: async () => {
    set({ currentFolderId: null, currentFolderName: null });
    get().clearSelection();
    get().focusAsset(null);
    await get().setQuery({ album_id: null });
  },
});

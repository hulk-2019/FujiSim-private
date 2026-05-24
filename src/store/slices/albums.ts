import type { StateCreator } from "zustand";
import { api } from "../../api";
import type { AppState, AlbumSlice } from "../types";

export const createAlbumSlice: StateCreator<AppState, [], [], AlbumSlice> = (set, get) => ({
  albums: [],
  albumSummaries: [],
  trashedAlbums: [],

  refreshAlbums: async () => {
    const list = await api.listAlbums().catch(() => []);
    set({ albums: list });
  },

  refreshAlbumSummaries: async () => {
    const list = await api.getAlbumSummaries().catch(() => []);
    set({ albumSummaries: list });
  },

  refreshTrash: async () => {
    const list = await api.listTrashAlbums().catch(() => []);
    set({ trashedAlbums: list });
  },

  restoreAlbum: async (id) => {
    await api.restoreAlbum(id);
    await Promise.all([get().refreshAlbums(), get().refreshAlbumSummaries(), get().refreshTrash()]);
  },

  purgeAlbum: async (id) => {
    await api.purgeAlbum(id);
    await get().refreshTrash();
  },

  purgeAllTrash: async () => {
    await api.purgeAllTrash();
    await get().refreshTrash();
  },
});

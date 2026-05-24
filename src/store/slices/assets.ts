import type { StateCreator } from "zustand";
import type { Asset } from "../../types";
import { api } from "../../api";
import type { AppState, AssetSlice } from "../types";

export const createAssetSlice: StateCreator<AppState, [], [], AssetSlice> = (set, get) => ({
  assets: [],
  totalCount: 0,
  isLoadingPage: new Set<number>(),
  loading: false,
  query: { sort_by: "date_taken", sort_dir: "desc" },
  selectedIds: new Set<number>(),
  focusedId: null,

  setQuery: async (q) => {
    set({ query: { ...get().query, ...q } });
    await get().refreshAssets();
  },

  refreshAssets: async () => {
    set({ loading: true, assets: [], totalCount: 0, isLoadingPage: new Set() });
    try {
      const { items, total } = await api.listAssets({ ...get().query, limit: 60, offset: 0 });
      const arr: (Asset | undefined)[] = Array(total).fill(undefined);
      items.forEach((item, i) => { arr[i] = item; });

      const validIds = new Set(items.map((a) => a.id));
      const prevSelected = get().selectedIds;
      let nextSelected = prevSelected;
      if (prevSelected.size > 0) {
        const filtered = new Set<number>();
        for (const id of prevSelected) {
          if (validIds.has(id)) filtered.add(id);
        }
        if (filtered.size !== prevSelected.size) nextSelected = filtered;
      }

      const focused = get().focusedId;
      let nextFocused: number | null = focused;
      if (focused == null || !validIds.has(focused)) {
        nextFocused =
          nextSelected.size > 0
            ? (nextSelected.values().next().value ?? null)
            : (get().currentFolderId !== null ? (items[0]?.id ?? null) : null);
      }

      set({
        assets: arr,
        totalCount: total,
        isLoadingPage: new Set(),
        loading: false,
        selectedIds: nextSelected,
        focusedId: nextFocused,
      });

    } catch (e) {
      console.error("refreshAssets failed", e);
      set({ loading: false });
    }
  },

  loadPage: async (offset: number) => {
    const { isLoadingPage, query } = get();
    if (isLoadingPage.has(offset)) return;
    const next = new Set(isLoadingPage);
    next.add(offset);
    set({ isLoadingPage: next });
    try {
      const { items, total } = await api.listAssets({ ...query, limit: 60, offset });
      set((state) => {
        const arr: (Asset | undefined)[] = state.assets.length === total
          ? [...state.assets]
          : Object.assign(Array(total).fill(undefined), state.assets.slice(0, total));
        items.forEach((item, i) => { arr[offset + i] = item; });
        const nextLoading = new Set(state.isLoadingPage);
        nextLoading.delete(offset);
        return { assets: arr, totalCount: total, isLoadingPage: nextLoading };
      });
    } catch (e) {
      console.error("loadPage failed", e);
      set((state) => {
        const nextLoading = new Set(state.isLoadingPage);
        nextLoading.delete(offset);
        return { isLoadingPage: nextLoading };
      });
    }
  },

  toggleSelect: (id, additive) => {
    const cur = new Set(get().selectedIds);
    if (additive) {
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
    } else {
      cur.clear();
      cur.add(id);
    }
    set({ selectedIds: cur, focusedId: id });
  },

  selectRange: (id) => {
    const { assets, focusedId } = get();
    if (!focusedId) {
      get().toggleSelect(id, false);
      return;
    }
    const a = assets.findIndex((x) => x?.id === focusedId);
    const b = assets.findIndex((x) => x?.id === id);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const cur = new Set(get().selectedIds);
    for (let i = lo; i <= hi; i++) {
      const asset = assets[i];
      if (asset !== undefined) cur.add(asset.id);
    }
    set({ selectedIds: cur });
  },

  clearSelection: () => set({ selectedIds: new Set() }),
  selectAll: () => set({
    selectedIds: new Set(
      get().assets.filter((a): a is Asset => a !== undefined).map((a) => a.id),
    ),
  }),
  focusAsset: (id) => set({ focusedId: id }),

  patchAsset: (updated) => set((state) => {
    const idx = state.assets.findIndex((a) => a?.id === updated.id);
    if (idx === -1) return {};
    const arr = [...state.assets];
    arr[idx] = updated;
    return { assets: arr };
  }),
  batchPatchAssets: (updates) => set((state) => {
    const map = new Map(updates.map((a) => [a.id, a]));
    let changed = false;
    const arr = state.assets.map((a) => {
      if (a && map.has(a.id)) { changed = true; return map.get(a.id)!; }
      return a;
    });
    return changed ? { assets: arr } : {};
  }),
});

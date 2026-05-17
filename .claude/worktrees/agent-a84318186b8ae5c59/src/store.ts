import { create } from "zustand";
import type {
  Asset,
  AssetQuery,
  BatchProgress,
  FilterPreset,
  FilterSettings,
  UserLut,
} from "./types";
import { api } from "./api";

/**
 * 默认的"出厂"滤镜参数。
 * 用作 `resetFilter` 的目标，以及组件挂载时的初始值。
 */
export const DEFAULT_FILTER: FilterSettings = {
  base_simulation: "Provia",
  grain_effect: "None",
  grain_size: "Small",
  color_chrome_effect: "None",
  highlight_tone: 0,
  shadow_tone: 0,
  color_saturation: 0,
  clarity: 0,
  sharpness: 0,
  wb_shift_r: 0,
  wb_shift_b: 0,
  lut_file_path: null,
};

/**
 * 应用全局状态（zustand store）。
 *
 * 设计原则：
 * - **唯一真相源**：所有跨组件共享的状态（资产列表、选择集、当前滤镜、预设、进度）都放这；
 * - **action 内置**：避免在组件里写复杂的 setState 链，直接 `useStore(s => s.refreshAssets)`；
 * - **selector 粒度**：组件中只订阅自己需要的字段（如 `useStore(s => s.assets)`），
 *   减少不必要的重渲染。
 */
type AppState = {
  // ===== UI 状态 =====
  theme: "light" | "dark";
  toggleTheme: () => void;

  // ===== 资产列表与查询 =====
  assets: Asset[];
  loading: boolean;
  query: AssetQuery;
  /** 当前选中（多选）的资产 id 集合，用于批操作 */
  selectedIds: Set<number>;
  /** 当前预览面板正在展示的资产 id（单选概念，与 selectedIds 解耦） */
  focusedId: number | null;

  // ===== 当前滤镜与预设 =====
  filter: FilterSettings;
  presets: FilterPreset[];
  /** 用户已导入的 3D LUT 库（与 presets 解耦，分别 CRUD） */
  userLuts: UserLut[];

  // ===== 筛选项缓存（侧边栏下拉用）=====
  cameras: string[];
  fujiSimulations: string[];

  // ===== 异步态：导入 / 导出进度 =====
  importing: boolean;
  lastImport: { inserted: number; scanned: number } | null;
  progress: BatchProgress | null;

  // ===== Actions =====
  /** 修改查询条件并立即刷新资产列表 */
  setQuery: (q: AssetQuery) => Promise<void>;
  refreshAssets: () => Promise<void>;
  /** 刷新筛选下拉里的"相机列表 / 富士预设名"等只读数据 */
  refreshFacets: () => Promise<void>;
  refreshPresets: () => Promise<void>;
  refreshUserLuts: () => Promise<void>;

  /** 单击：若 additive=true（Cmd/Ctrl 按下）则切换选中，否则单选 */
  toggleSelect: (id: number, additive: boolean) => void;
  /** Shift 框选：以 focusedId 为锚点，把当前 id 与锚点之间的所有资产纳入 */
  selectRange: (id: number) => void;
  clearSelection: () => void;
  selectAll: () => void;
  focusAsset: (id: number | null) => void;

  setFilter: (patch: Partial<FilterSettings>) => void;
  resetFilter: () => void;
  /** 把一个预设的所有字段一次性写入当前 filter */
  applyPreset: (preset: FilterPreset) => void;

  setProgress: (p: BatchProgress | null) => void;
  setImporting: (flag: boolean, last?: { inserted: number; scanned: number } | null) => void;
};

export const useStore = create<AppState>((set, get) => ({
  theme: (localStorage.getItem("fujisim-theme") as "light" | "dark") || "light",
  toggleTheme: () => {
    const newTheme = get().theme === "light" ? "dark" : "light";
    localStorage.setItem("fujisim-theme", newTheme);
    if (newTheme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    set({ theme: newTheme });
  },

  assets: [],
  loading: false,
  query: { sort_by: "date_taken", sort_dir: "desc", limit: 500 },
  selectedIds: new Set(),
  focusedId: null,
  filter: { ...DEFAULT_FILTER },
  presets: [],
  userLuts: [],
  cameras: [],
  fujiSimulations: [],
  importing: false,
  lastImport: null,
  progress: null,

  setQuery: async (q) => {
    set({ query: { ...get().query, ...q } });
    await get().refreshAssets();
  },

  refreshAssets: async () => {
    set({ loading: true });
    try {
      const list = await api.listAssets(get().query);
      // 收敛 selectedIds：把已被删除/筛掉的 id 剔除，保持选择集合始终是当前列表的子集
      const validIds = new Set(list.map((a) => a.id));
      const prevSelected = get().selectedIds;
      let nextSelected = prevSelected;
      if (prevSelected.size > 0) {
        const filtered = new Set<number>();
        for (const id of prevSelected) {
          if (validIds.has(id)) filtered.add(id);
        }
        if (filtered.size !== prevSelected.size) nextSelected = filtered;
      }

      // 收敛 focusedId：当前聚焦失效时，优先聚焦还在选中集合里的某一项（删除一批后能继续看下一张），
      // 否则退回到列表首张；列表为空则置空。
      const focused = get().focusedId;
      let nextFocused: number | null = focused;
      if (focused == null || !validIds.has(focused)) {
        nextFocused =
          nextSelected.size > 0
            ? (nextSelected.values().next().value ?? null)
            : (list[0]?.id ?? null);
      }

      set({
        assets: list,
        loading: false,
        selectedIds: nextSelected,
        focusedId: nextFocused,
      });
    } catch (e) {
      console.error("refreshAssets failed", e);
      set({ loading: false });
    }
  },

  refreshFacets: async () => {
    const [cams, sims] = await Promise.all([
      api.distinctCameras().catch(() => []),
      api.listFujiSimulations().catch(() => []),
    ]);
    set({ cameras: cams, fujiSimulations: sims });
  },

  refreshPresets: async () => {
    const p = await api.listPresets().catch(() => []);
    set({ presets: p });
  },

  refreshUserLuts: async () => {
    const luts = await api.listUserLuts().catch(() => []);
    set({ userLuts: luts });
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
    // Shift 框选：以 focusedId 为锚点找到起/止索引，把区间内所有资产纳入选中集
    const { assets, focusedId } = get();
    if (!focusedId) {
      get().toggleSelect(id, false);
      return;
    }
    const a = assets.findIndex((x) => x.id === focusedId);
    const b = assets.findIndex((x) => x.id === id);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const cur = new Set(get().selectedIds);
    for (let i = lo; i <= hi; i++) cur.add(assets[i].id);
    set({ selectedIds: cur });
  },

  clearSelection: () => set({ selectedIds: new Set() }),
  selectAll: () => set({ selectedIds: new Set(get().assets.map((a) => a.id)) }),
  focusAsset: (id) => set({ focusedId: id }),

  setFilter: (patch) => set({ filter: { ...get().filter, ...patch } }),
  resetFilter: () => set({ filter: { ...DEFAULT_FILTER } }),
  applyPreset: (preset) =>
    set({
      filter: {
        base_simulation: preset.base_simulation,
        grain_effect: preset.grain_effect ?? "None",
        grain_size: preset.grain_size ?? "Small",
        color_chrome_effect: preset.color_chrome_effect ?? "None",
        highlight_tone: preset.highlight_tone,
        shadow_tone: preset.shadow_tone,
        color_saturation: preset.color_saturation,
        clarity: preset.clarity,
        sharpness: preset.sharpness,
        wb_shift_r: preset.wb_shift_r,
        wb_shift_b: preset.wb_shift_b,
        lut_file_path: preset.lut_file_path ?? null,
      },
    }),

  setProgress: (p) => set({ progress: p }),
  setImporting: (flag, last) =>
    set({ importing: flag, lastImport: last ?? get().lastImport }),
}));

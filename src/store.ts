import { create } from "zustand";
import type {
  Album,
  Asset,
  AssetQuery,
  BatchProgress,
  BatchTask,
  FilterPreset,
  FilterSettings,
  UserFont,
  UserLut,
  WatermarkPreset,
  WatermarkSettings,
} from "./types";

/** 从预设中提取可直接写入 filter 的字段，补全可选字段的默认值 */
function presetToFilter(preset: FilterPreset): FilterSettings {
  return {
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
  };
}
import { api } from "./api";
import { DEFAULT_WATERMARK } from "./types";
import { registerFont, unregisterFont } from "./lib/fontManager";

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
  language: "zh" | "en";
  toggleLanguage: () => void;

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
  watermark: WatermarkSettings;
  /** 用户已导入的字体，启动时从 SQLite 恢复 */
  userFonts: UserFont[];
  /** 用户保存的水印自定义预设 */
  watermarkPresets: WatermarkPreset[];
  /** 当前选中的水印预设 id，null 表示未选中 */
  selectedWatermarkPresetId: number | null;
  /** 当前预览图的实际像素尺寸，用于水印导出时的比例换算 */
  previewSize: { width: number; height: number } | null;
  /** previewSize 对应的资产 id，用于校验是否过期 */
  previewSizeAssetId: number | null;
  /** 预览容器在屏幕上的 CSS 像素尺寸，水印 Canvas 渲染时以此为基准 */
  previewContainerSize: { width: number; height: number } | null;

  // ===== 筛选项缓存（侧边栏下拉用）=====
  cameras: string[];
  fujiSimulations: string[];
  albums: Album[];

  // ===== 异步态：导入 / 导出进度 =====
  importing: boolean;
  lastImport: { inserted: number; scanned: number } | null;
  /** 所有并发导出任务的进度，key = task_id */
  exportTasks: Map<number, BatchProgress>;
  /** 导出任务的完整 SQLite 记录，key = task_id */
  taskDetails: Map<number, BatchTask>;
  /** 软删除：用户已关闭的任务 id，不从 exportTasks 移除，只在 UI 过滤 */
  dismissedTaskIds: Set<number>;
  /** @deprecated 保留兼容旧代码，指向最新一条任务的进度 */
  progress: BatchProgress | null;

  // ===== RAW 缩略图缓存 =====
  /** 后端缩略图目录的绝对路径，App 启动时从后端获取一次 */
  thumbnailDir: string | null;
  /** 已确认磁盘上有 {id}.jpg 缩略图文件的 asset id 集合 */
  rawThumbnailReady: Set<number>;
  setThumbnailDir: (dir: string) => void;
  markThumbnailReady: (assetId: number) => void;
  /** 清空 rawThumbnailReady（清除缓存后调用） */
  clearThumbnailReady: () => void;

  // ===== Actions =====
  /** 修改查询条件并立即刷新资产列表 */
  setQuery: (q: AssetQuery) => Promise<void>;
  refreshAssets: () => Promise<void>;
  /** 刷新筛选下拉里的"相机列表 / 富士预设名"等只读数据 */
  refreshFacets: () => Promise<void>;
  refreshPresets: () => Promise<void>;
  refreshUserLuts: () => Promise<void>;
  refreshAlbums: () => Promise<void>;

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
  dismissExportTask: (taskId: number) => Promise<void>;
  cancelExportTask: (taskId: number) => Promise<void>;
  clearCompletedExportTasks: () => Promise<void>;
  retryExportTask: (taskId: number) => Promise<void>;
  setWatermark: (patch: Partial<WatermarkSettings>) => void;
  addUserFont: (paths: string[]) => Promise<void>;
  removeUserFont: (id: number) => Promise<void>;
  addWatermarkPreset: (name: string) => void;
  removeWatermarkPreset: (id: number) => void;
  updateWatermarkPreset: (id: number, name: string) => void;
  applyWatermarkPreset: (preset: WatermarkPreset) => void;
  refreshWatermarkPresets: () => Promise<void>;
  setSelectedWatermarkPresetId: (id: number | null) => void;
  setPreviewSize: (size: { width: number; height: number } | null, assetId?: number | null) => void;
  setPreviewContainerSize: (size: { width: number; height: number } | null) => void;
  
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
  language: (localStorage.getItem("fujisim-language") as "zh" | "en") || "zh",
  toggleLanguage: () => {
    const newLang = get().language === "zh" ? "en" : "zh";
    localStorage.setItem("fujisim-language", newLang);
    set({ language: newLang });
    import("@/i18n").then(({ default: i18n }) => i18n.changeLanguage(newLang));
  },

  assets: [],
  loading: false,
  query: { sort_by: "date_taken", sort_dir: "desc", limit: 100 },
  selectedIds: new Set(),
  focusedId: null,
  filter: { ...DEFAULT_FILTER },
  presets: [],
  userLuts: [],
  watermark: { ...DEFAULT_WATERMARK },
  userFonts: [],
  watermarkPresets: [],
  selectedWatermarkPresetId: null,
  previewSize: null,
  previewSizeAssetId: null,
  previewContainerSize: null,
  cameras: [],
  fujiSimulations: [],
  albums: [],
  importing: false,
  lastImport: null,
  exportTasks: new Map(),
  taskDetails: new Map(),
  dismissedTaskIds: new Set(),
  progress: null,
  thumbnailDir: null,
  rawThumbnailReady: new Set<number>(),

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

      // 后台预生成 RAW 缩略图（fire-and-forget，延迟 600ms 让 UI 先渲染完）
      const rawIds = list.filter((a) => Boolean(a.is_raw)).map((a) => a.id);
      if (rawIds.length > 0) {
        setTimeout(() => api.generateThumbnails(rawIds).catch(() => {}), 600);
      }
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

  refreshAlbums: async () => {
    const list = await api.listAlbums().catch(() => []);
    set({ albums: list });
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
  applyPreset: (preset) => set({ filter: presetToFilter(preset) }),

  setProgress: (p) => {
    if (!p) return;
    const nextTasks = new Map(get().exportTasks);
    nextTasks.set(p.task_id, p);

    const details = get().taskDetails;
    const detail = details.get(p.task_id);

    if (p.done && detail) {
      const finalStatus = p.failed > 0 ? "error" : "done";
      const nextDetails = new Map(details);
      nextDetails.set(p.task_id, { ...detail, status: finalStatus });
      set({ exportTasks: nextTasks, progress: p, taskDetails: nextDetails });
      return;
    }

    set({ exportTasks: nextTasks, progress: p });

    // 收到进度事件但 UI 状态不是 processing → 从 DB 拉取最新 status
    if (!p.done && detail?.status !== "processing") {
      api.getTask(p.task_id).then((t) => {
        if (!t) return;
        const cur = get().taskDetails;
        const nextDetails = new Map(cur);
        nextDetails.set(t.id, t);
        set({ taskDetails: nextDetails });
      }).catch(() => {});
    }
  },
  setImporting: (flag, last) =>
    set({ importing: flag, lastImport: last ?? get().lastImport }),
  // 删除单个任务：先取消（DB 状态→cancelled，停止 rayon 工作线程），再软删除
  dismissExportTask: async (taskId) => {
    await api.cancelExportTask(taskId).catch(() => {});
    await api.deleteExportTask(taskId).catch(() => {});
    set({ dismissedTaskIds: new Set([...get().dismissedTaskIds, taskId]) });
  },
  // 取消任务：状态变为 cancelled，UI 仍然可见（让用户可以看到/重试）
  cancelExportTask: async (taskId) => {
    await api.cancelExportTask(taskId).catch(() => {});
    const details = get().taskDetails;
    const detail = details.get(taskId);
    if (detail) {
      set({ taskDetails: new Map(details).set(taskId, { ...detail, status: "cancelled" }) });
    }
  },
  // 一键清空：所有任务取消并软删除（DB + UI）
  clearCompletedExportTasks: async () => {
    const { exportTasks, dismissedTaskIds } = get();
    const allIds = [...exportTasks.values()]
      .filter((t) => !dismissedTaskIds.has(t.task_id))
      .map((t) => t.task_id);
    if (allIds.length === 0) return;
    await api.deleteAllExportTasks(allIds).catch(() => {});
    set({ dismissedTaskIds: new Set([...dismissedTaskIds, ...allIds]) });
  },
  // 重试：复用原 task_id，后端从 DB 恢复水印层，无需前端重新渲染
  retryExportTask: async (taskId) => {
    try {
      await api.retryExportTask(taskId, null);

      const next = new Set(get().dismissedTaskIds);
      next.delete(taskId);
      const detail = get().taskDetails.get(taskId);
      if (detail) {
        set({
          dismissedTaskIds: next,
          taskDetails: new Map(get().taskDetails).set(taskId, { ...detail, status: "pending" }),
        });
      } else {
        set({ dismissedTaskIds: next });
      }
    } catch (e) {
      console.error("retryExportTask failed", e);
    }
  },
  setWatermark: (patch) => set({ watermark: { ...get().watermark, ...patch } }),
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
  setPreviewSize: (size, assetId) => set({ previewSize: size, previewSizeAssetId: assetId ?? null }),
  setPreviewContainerSize: (size) => set({ previewContainerSize: size }),
  refreshWatermarkPresets: async () => {
    const presets = await api.listWatermarkPresets().catch(() => []);
    set({ watermarkPresets: presets });
  },
  addWatermarkPreset: async (name) => {
    const settingsJson = JSON.stringify(get().watermark);
    const preset = await api.createWatermarkPreset(name, settingsJson);
    set({ watermarkPresets: [...get().watermarkPresets, preset], selectedWatermarkPresetId: preset.id });
  },
  updateWatermarkPreset: async (id, name) => {
    const settingsJson = JSON.stringify(get().watermark);
    const updated = await api.updateWatermarkPreset(id, name, settingsJson);
    set({ watermarkPresets: get().watermarkPresets.map((p) => (p.id === id ? updated : p)) });
  },
  removeWatermarkPreset: async (id) => {
    await api.deleteWatermarkPreset(id);
    const next = get().watermarkPresets.filter((p) => p.id !== id);
    set({ watermarkPresets: next, selectedWatermarkPresetId: get().selectedWatermarkPresetId === id ? null : get().selectedWatermarkPresetId });
  },
  applyWatermarkPreset: (preset) => {
    try {
      const settings = JSON.parse(preset.settings_json);
      set({ watermark: { ...get().watermark, ...settings }, selectedWatermarkPresetId: preset.id });
    } catch { /* ignore malformed json */ }
  },
  setSelectedWatermarkPresetId: (id) => set({ selectedWatermarkPresetId: id }),
  setThumbnailDir: (dir) => set({ thumbnailDir: dir }),
  markThumbnailReady: (assetId) => {
    const next = new Set(get().rawThumbnailReady);
    next.add(assetId);
    set({ rawThumbnailReady: next });
  },
  clearThumbnailReady: () => set({ rawThumbnailReady: new Set() }),
}));

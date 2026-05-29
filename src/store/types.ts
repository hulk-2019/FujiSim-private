export type EyedropperMode = 'none' | 'white-balance';

import type {
  Project,
  ProjectSummary,
  Asset,
  AssetQuery,
  BatchProgress,
  BatchTask,
  FilterPreset,
  FilterSettings,
  HistogramData,
  PresetCategory,
  UserFont,
  UserLut,
  WatermarkPreset,
  WatermarkSettings,
} from "../types";

/**
 * 资产列表 / 查询 / 分页 / 选择 / 聚焦 相关状态。
 */
export interface AssetSlice {
  assets: (Asset | undefined)[];
  totalCount: number;
  isLoadingPage: Set<number>;
  loading: boolean;
  query: AssetQuery;
  /** 当前选中（多选）的资产 id 集合，用于批操作 */
  selectedIds: Set<number>;
  /** 当前预览面板正在展示的资产 id（单选概念，与 selectedIds 解耦） */
  focusedId: number | null;

  /** 修改查询条件并立即刷新资产列表 */
  setQuery: (q: AssetQuery) => Promise<void>;
  refreshAssets: () => Promise<void>;
  loadPage: (offset: number) => Promise<void>;

  /** 单击：若 additive=true（Cmd/Ctrl 按下）则切换选中，否则单选 */
  toggleSelect: (id: number, additive: boolean) => void;
  /** Shift 框选：以 focusedId 为锚点，把当前 id 与锚点之间的所有资产纳入 */
  selectRange: (id: number) => void;
  clearSelection: () => void;
  selectAll: () => void;
  focusAsset: (id: number | null) => void;

  /** 用单条最新 asset 数据原地更新 assets 数组（封面生成完成后调用） */
  patchAsset: (updated: Asset) => void;
  /** 批量原地更新多条 asset，单次状态更新避免多次重渲染 */
  batchPatchAssets: (updates: Asset[]) => void;
}

/**
 * 当前滤镜（编辑参数）。
 */
export interface FilterSlice {
  filter: FilterSettings;
  histogram: HistogramData | null;
  eyedropperMode: EyedropperMode;
  isAdjustingFilter: boolean;
  filterInteraction: "idle" | "dragging" | "preset_applied" | "settling";
  setFilter: (patch: Partial<FilterSettings>) => void;
  resetFilter: () => void;
  applyPreset: (preset: FilterPreset) => void;
  setEyedropperMode: (mode: EyedropperMode) => void;
  setHistogram: (data: HistogramData | null) => void;
  setIsAdjustingFilter: (isAdjusting: boolean) => void;
  setFilterInteraction: (interaction: FilterSlice["filterInteraction"]) => void;
}

/**
 * 用户保存的滤镜预设。
 */
export interface PresetSlice {
  presets: FilterPreset[];
  refreshPresets: () => Promise<void>;
}

/**
 * 用户已导入的 3D LUT 库（与 presets 解耦，分别 CRUD）。
 */
export interface UserLutSlice {
  userLuts: UserLut[];
  refreshUserLuts: () => Promise<void>;
}

/**
 * 预设分类与文件夹导航。
 */
export interface CategorySlice {
  categories: PresetCategory[];
  currentFolderId: number | null;
  currentFolderName: string | null;
  refreshCategories: () => Promise<void>;
  createCategory: (name: string) => Promise<PresetCategory>;
  renameCategory: (id: number, name: string) => Promise<PresetCategory>;
  deleteCategory: (id: number) => Promise<void>;
  setPresetCategory: (presetId: number, categoryId: number | null) => Promise<void>;
  setUserLutCategory: (lutId: number, categoryId: number | null) => Promise<void>;
  enterFolder: (id: number, name: string) => Promise<void>;
  exitFolder: () => Promise<void>;
}

/**
 * 相册（含汇总与回收站）。
 */
export interface ProjectSlice {
  projects: Project[];
  projectSummaries: ProjectSummary[];
  trashedProjects: ProjectSummary[];
  refreshProjects: () => Promise<void>;
  refreshProjectSummaries: () => Promise<void>;
  refreshTrash: () => Promise<void>;
  restoreProject: (id: number) => Promise<void>;
  purgeProject: (id: number) => Promise<void>;
  purgeAllTrashProjects: () => Promise<void>;
}

/**
 * 导入 / 导出任务进度。
 */
export interface ExportSlice {
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

  setProgress: (p: BatchProgress | null) => void;
  setImporting: (flag: boolean, last?: { inserted: number; scanned: number } | null) => void;
  dismissExportTask: (taskId: number) => Promise<void>;
  cancelExportTask: (taskId: number) => Promise<void>;
  clearCompletedExportTasks: () => Promise<void>;
  retryExportTask: (taskId: number) => Promise<void>;
}

/**
 * 水印及水印预设。
 */
export interface WatermarkSlice {
  watermark: WatermarkSettings;
  /** 用户保存的水印自定义预设 */
  watermarkPresets: WatermarkPreset[];
  /** 当前选中的水印预设 id，null 表示未选中 */
  selectedWatermarkPresetId: number | null;
  /** 当前预览图的实际像素尺寸，用于水印导出时的比例换算 */
  previewSize: { width: number; height: number } | null;
  /** previewSize 对应的资产 id，用于校验是否过期 */
  previewSizeAssetId: number | null;

  setWatermark: (patch: Partial<WatermarkSettings>) => void;
  addWatermarkPreset: (name: string) => void;
  removeWatermarkPreset: (id: number) => void;
  updateWatermarkPreset: (id: number, name: string) => void;
  applyWatermarkPreset: (preset: WatermarkPreset) => void;
  refreshWatermarkPresets: () => Promise<void>;
  setSelectedWatermarkPresetId: (id: number | null) => void;
  setPreviewSize: (size: { width: number; height: number } | null, assetId?: number | null) => void;
}

/**
 * 用户字体。
 */
export interface FontSlice {
  /** 用户已导入的字体，启动时从 SQLite 恢复 */
  userFonts: UserFont[];
  addUserFont: (paths: string[]) => Promise<void>;
  removeUserFont: (id: number) => Promise<void>;
}

/**
 * 筛选下拉项（侧边栏只读数据）。
 */
export interface FacetSlice {
  cameras: string[];
  fujiSimulations: string[];
  /** 刷新筛选下拉里的"相机列表 / 富士预设名"等只读数据 */
  refreshFacets: () => Promise<void>;
}

/**
 * 应用全局状态（zustand store）。
 *
 * 设计原则：
 * - **唯一真相源**：所有跨组件共享的状态（资产列表、选择集、当前滤镜、预设、进度）都放这；
 * - **action 内置**：避免在组件里写复杂的 setState 链，直接 `useStore(s => s.refreshAssets)`；
 * - **selector 粒度**：组件中只订阅自己需要的字段（如 `useStore(s => s.assets)`），
 *   减少不必要的重渲染。
 */
export type AppState =
  & AssetSlice
  & FilterSlice
  & PresetSlice
  & UserLutSlice
  & CategorySlice
  & ProjectSlice
  & ExportSlice
  & WatermarkSlice
  & FontSlice
  & FacetSlice;

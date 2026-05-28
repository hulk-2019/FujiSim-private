/**
 * 前端 TypeScript 类型定义。
 *
 * 命名/字段与 Rust 后端 (`src-tauri/src/db/*`、`src-tauri/src/processing/pipeline.rs`
 * 等处的 serde 结构) 严格对齐。后端添加新字段时，这里也要同步加，否则 IPC 反序列化
 * 会丢字段。
 *
 * SQLite 没有原生布尔，因此 `is_raw` / `is_builtin` 这类字段的类型是 `number` (0/1)，
 * 在 UI 里用 `Boolean(a.is_raw)` 转换。
 */

/** 资产读模型，对应 Rust 端 `crate::db::assets::Asset` */
export type Asset = {
  id: number;
  file_path: string;
  file_name: string;
  file_type?: string | null;
  file_size?: number | null;
  date_taken?: string | null;
  camera_make?: string | null;
  camera_model?: string | null;
  lens_model?: string | null;
  iso?: number | null;
  f_number?: number | null;
  shutter_speed?: string | null;
  focal_length?: number | null;
  star_rating: number;
  color_label?: string | null;
  width?: number | null;
  height?: number | null;
  /** SQLite 用 0/1 表示布尔 */
  is_raw: number;
  cover_path: string | null;
  created_at: string;
};

/** 虚拟相册 */
export type Album = {
  id: number;
  name: string;
  created_at: string;
  is_deleted: number;
  deleted_at: string | null;
};

/** 相册摘要（含封面路径和资产数量） */
export type AlbumSummary = {
  id: number;
  name: string;
  created_at: string;
  is_deleted: number;
  deleted_at: string | null;
  total: number;
  cover_paths: string[];
};

export type PresetCategory = {
  id: number;
  name: string;
  sort_order: number;
  created_at: string;
};

/** 滤镜预设的读模型，包含 13 个内置（is_builtin=1）+ 任意用户自定义 */
export type FilterPreset = {
  id: number;
  name: string;
  base_simulation: string;
  grain_amount: number;
  grain_size: number;
  grain_roughness: number;
  grain_color: number;
  exposure: number;
  contrast: number;
  brightness: number;
  highlight_tone: number;
  shadow_tone: number;
  white: number;
  black: number;
  dehaze: number;
  vibrance: number;
  color_saturation: number;
  clarity: number;
  sharpness: number;
  wb_shift_r: number;
  wb_shift_g: number;
  wb_shift_b: number;
  lut_file_path?: string | null;
  is_builtin: number;
  category_id?: number | null;
  created_at: string;
};

/** 写预设时的输入类型：没有 id/created_at，is_builtin 用真正的布尔 */
export type NewFilterPreset = Omit<FilterPreset, "id" | "created_at" | "is_builtin"> & {
  is_builtin: boolean;
};

export type CurvePoint = { x: number; y: number };

export type ToneCurvePoints = {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
};

/** 用户当前在 UI 上看到的滤镜参数。每次调整滑块都会 patch 这个对象 */
export type FilterSettings = {
  base_simulation: string;
  grain_amount: number;
  grain_size: number;
  grain_roughness: number;
  grain_color: number;
  exposure: number;
  contrast: number;
  brightness: number;
  highlight_tone: number;
  shadow_tone: number;
  white: number;
  black: number;
  dehaze: number;
  vibrance: number;
  color_saturation: number;
  clarity: number;
  sharpness: number;
  wb_shift_r: number;
  wb_shift_g: number;
  wb_shift_b: number;
  hsl_red_hue: number;
  hsl_red_sat: number;
  hsl_red_lum: number;
  hsl_orange_hue: number;
  hsl_orange_sat: number;
  hsl_orange_lum: number;
  hsl_yellow_hue: number;
  hsl_yellow_sat: number;
  hsl_yellow_lum: number;
  hsl_green_hue: number;
  hsl_green_sat: number;
  hsl_green_lum: number;
  hsl_aqua_hue: number;
  hsl_aqua_sat: number;
  hsl_aqua_lum: number;
  hsl_blue_hue: number;
  hsl_blue_sat: number;
  hsl_blue_lum: number;
  hsl_purple_hue: number;
  hsl_purple_sat: number;
  hsl_purple_lum: number;
  hsl_magenta_hue: number;
  hsl_magenta_sat: number;
  hsl_magenta_lum: number;
  tone_curve?: ToneCurvePoints | null;
  lut_file_path?: string | null;
};

/** 资产列表查询条件，所有字段可选，前端按需带 */
export type AssetQuery = {
  camera_model?: string | null;
  lens_model?: string | null;
  min_rating?: number | null;
  color_label?: string | null;
  min_iso?: number | null;
  max_iso?: number | null;
  album_id?: number | null;
  search?: string | null;
  sort_by?: "date_taken" | "file_name" | "camera_model" | "lens_model" | "iso" | "star_rating" | "created_at";
  sort_dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

/** 资产库统计概览，用于侧边栏/Dashboard */
export type LibraryStats = {
  total: number;
  by_camera: [string, number][];
};

/** 导入目录的回执 */
export type ImportReport = {
  inserted: number;
  scanned: number;
  skipped: number;
};

export type HistogramData = {
  r: number[];
  g: number[];
  b: number[];
  luma: number[];
  totalPixels: number;
};

export type PreviewMode = "interactive" | "settled" | "full" | "tile";

export type PreviewTileRequest = {
  x: number;
  y: number;
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
};

/** 预览渲染结果。常规预览返回 `data`，full 预览可能返回本地 `path`。 */
export type PreviewResult = {
  path?: string | null;
  data?: number[] | null;
  mimeType?: string | null;
  width: number;
  height: number;
};

/** 批量导出进度事件，由后端通过 `export:progress` Tauri Event 推送 */
export type BatchProgress = {
  task_id: number;
  total: number;
  completed: number;
  failed: number;
  last_asset_id?: number | null;
  last_output?: string | null;
  last_error?: string | null;
  done: boolean;
};

export type ExportFormat = "jpeg" | "png" | "tiff" | "webp" | "gif" | "bmp";

/** 尺寸缩放规则。LongEdge=按最长边缩到 N 像素；Percent=按百分比 */
export type ResizeSpec =
  | { long_edge: number }
  | { percent: number };

/** 输出目录：原文件旁子文件夹 / 自定义绝对路径 */
export type Destination =
  | { kind: "subfolder"; name: string }
  | { kind: "path"; path: string };

/** 完整导出设置，与 Rust 端 `ExportSettings` 一一对应 */
export type ExportSettings = {
  format: ExportFormat;
  quality: number;
  destination: Destination;
  resize: ResizeSpec | null;
  strip_gps: boolean;
  filename_template: string | null;
};

/** 历史批量任务的读模型，每行对应一个资产的一次导出 */
export type BatchTask = {
  id: number;
  status: string;
  asset_id: number;
  total: number;
  completed: number;
  failed: number;
  export_settings_json: string;
  filter_settings_json: string;
  watermark_json?: string | null;
  watermark_layer_path?: string | null;
  created_at: string;
};

/** 颜色标签的允许值。新增颜色时同步改后端 `set_color_label` 校验（当前后端不校验） */
export const COLOR_LABELS = ["red", "yellow", "green", "blue", "purple"] as const;
export type ColorLabel = (typeof COLOR_LABELS)[number];

export type UserLut = {
  id: number;
  name: string;
  file_path: string;
  category_id?: number | null;
  created_at: string;
};

/** 选用户 LUT 时写到 `base_simulation` 的哨兵值，pipeline 用它走"恒等"分支。 */
export const PASS_THROUGH_SIM = "Pass-Through";

/** 用户导入的字体，元数据存 SQLite，文件复制到 data_dir/fonts/ */
export type UserFont = {
  id: number;
  name: string;
  file_path: string;
  ext: string;
  created_at: string;
};

/** 用户保存的水印自定义预设，存在 SQLite。后端字段与此一一对应。 */
export type WatermarkPreset = {
  id: number;
  name: string;
  settings_json: string;
  created_at: string;
};

/** 水印位置预设 */
export type WatermarkPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"
  | "left-center"
  | "right-center"
  | "center"
  | "custom";

/** 水印设置，纯前端预览用；导出时可扩展传给后端 */
export type WatermarkSettings = {
  enabled: boolean;
  text: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  opacity: number;
  italic: boolean;
  italicDegree: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  position: WatermarkPosition;
  offsetX: number;
  offsetY: number;
  nudgeStep: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  bold: boolean;
  strokeEnabled: boolean;
  strokeColor: string;
  strokeWidth: number;
};

export const DEFAULT_WATERMARK: WatermarkSettings = {
  enabled: false,
  text: "© FujiSim",
  fontSize: 32,
  fontFamily: "Arial, sans-serif",
  color: "#ffffff",
  opacity: 0.7,
  italic: false,
  italicDegree: 15,
  shadowEnabled: true,
  shadowColor: "#000000",
  shadowBlur: 4,
  shadowOffsetX: 1,
  shadowOffsetY: 1,
  position: "bottom-center",
  offsetX: 0,
  offsetY: 0,
  nudgeStep: 5,
  rotation: 0,
  flipH: false,
  flipV: false,
  bold: false,
  strokeEnabled: false,
  strokeColor: "#000000",
  strokeWidth: 2,
};

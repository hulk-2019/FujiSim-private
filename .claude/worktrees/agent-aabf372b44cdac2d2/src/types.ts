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
  created_at: string;
};

/** 虚拟相册 */
export type Album = {
  id: number;
  name: string;
  created_at: string;
};

/** 滤镜预设的读模型，包含 13 个内置（is_builtin=1）+ 任意用户自定义 */
export type FilterPreset = {
  id: number;
  name: string;
  base_simulation: string;
  grain_effect?: string | null;
  grain_size?: string | null;
  color_chrome_effect?: string | null;
  highlight_tone: number;
  shadow_tone: number;
  color_saturation: number;
  clarity: number;
  sharpness: number;
  wb_shift_r: number;
  wb_shift_b: number;
  lut_file_path?: string | null;
  is_builtin: number;
  created_at: string;
};

/** 写预设时的输入类型：没有 id/created_at，is_builtin 用真正的布尔 */
export type NewFilterPreset = Omit<FilterPreset, "id" | "created_at" | "is_builtin"> & {
  is_builtin: boolean;
};

/** 用户当前在 UI 上看到的滤镜参数。每次调整滑块都会 patch 这个对象 */
export type FilterSettings = {
  base_simulation: string;
  grain_effect?: string | null;
  grain_size?: string | null;
  color_chrome_effect?: string | null;
  highlight_tone: number;
  shadow_tone: number;
  color_saturation: number;
  clarity: number;
  sharpness: number;
  wb_shift_r: number;
  wb_shift_b: number;
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

/** 预览渲染结果。`data` 是 base64 编码的 JPEG，前端直接拼成 `data:` URL 显示 */
export type PreviewResult = {
  mime: string;
  data: string;
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

export type ExportFormat = "jpeg" | "png" | "tiff" | "webp";

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

/** 历史批量任务的读模型 */
export type BatchTask = {
  id: number;
  status: string;
  total: number;
  completed: number;
  failed: number;
  export_settings_json: string;
  filter_settings_json: string;
  created_at: string;
  completed_at?: string | null;
};

/** 颜色标签的允许值。新增颜色时同步改后端 `set_color_label` 校验（当前后端不校验） */
export const COLOR_LABELS = ["red", "yellow", "green", "blue", "purple"] as const;
export type ColorLabel = (typeof COLOR_LABELS)[number];

/**
 * 用户批量导入的 3D LUT 库条目。
 * `file_path` 指向应用数据目录下 `luts/` 子目录的副本（导入时复制进去）。
 */
export type UserLut = {
  id: number;
  name: string;
  file_path: string;
  created_at: string;
};

/** 选用户 LUT 时写到 `base_simulation` 的哨兵值，pipeline 用它走"恒等"分支。 */
export const PASS_THROUGH_SIM = "Pass-Through";

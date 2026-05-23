import { invoke } from "@tauri-apps/api/core";
import type {
  Album,
  AlbumSummary,
  Asset,
  AssetQuery,
  BatchProgress,
  BatchTask,
  ExportSettings,
  FilterPreset,
  FilterSettings,
  ImportReport,
  LibraryStats,
  NewFilterPreset,
  PreviewResult,
  UserLut,
  UserFont,
  WatermarkPreset,
} from "./types";

/**
 * Tauri IPC 调用的薄封装。
 *
 * 每个方法对应 Rust 端 `src-tauri/src/ipc.rs` 里的一个 `#[tauri::command]`。
 * Tauri 在 JS 端用 camelCase、Rust 端用 snake_case，invoke 自动转换；
 * 我们这里**保留 snake_case 参数名**（如 `assetIds`）是因为 Tauri 的
 * 参数转换只针对最外层 key（命令名），嵌套对象字段会原样直传给 serde。
 *
 * 错误统一为字符串：后端 `AppError` 实现了 `Serialize` 转字符串，
 * 调用方在 `catch (e)` 里拿到的就是可读 message。
 */
export const api = {
  // ===== 资产导入 / 查询 =====
  /** 选择目录后递归扫描并入库，返回扫描统计。
   *  传 `albumId` 时会把本次扫到的资产一并挂到该相册（新增 + 已存在都挂）。 */
  importDirectory: (path: string, albumId?: number | null) =>
    invoke<ImportReport>("import_directory", { path, albumId: albumId ?? null }),
  /** 批量导入用户手动选择的图片文件（不递归）。传 `albumId` 时同样挂到相册。 */
  importFiles: (paths: string[], albumId?: number | null) =>
    invoke<ImportReport>("import_files", { paths, albumId: albumId ?? null }),
  listAssets: (query: AssetQuery = {}) => invoke<{ items: Asset[]; total: number }>("list_assets", { query }),
  getAsset: (id: number) => invoke<Asset>("get_asset", { id }),
  libraryStats: () => invoke<LibraryStats>("library_stats"),
  distinctCameras: () => invoke<string[]>("distinct_cameras"),
  distinctLenses: () => invoke<string[]>("distinct_lenses"),

  // ===== 单条资产更新 =====
  setRating: (id: number, rating: number) => invoke<void>("set_rating", { id, rating }),
  setColorLabel: (id: number, label: string | null) =>
    invoke<void>("set_color_label", { id, label }),

  // ===== 物理操作（重命名 / 移动 / 删除）=====
  /** `moveToTrash=true` 时把原文件送进系统回收站，否则仅从数据库移除 */
  deleteAssets: (ids: number[], moveToTrash: boolean) =>
    invoke<void>("delete_assets", { ids, moveToTrash }),
  renameAsset: (id: number, newName: string) =>
    invoke<Asset>("rename_asset", { id, newName }),
  renameAssets: (ids: number[], template: string) =>
    invoke<Asset[]>("rename_assets", { ids, template }),
  moveAssets: (ids: number[], targetDir: string) =>
    invoke<Asset[]>("move_assets", { ids, targetDir }),
  /** 在系统文件管理器中定位并高亮该文件 */
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),

  // ===== 虚拟相册 =====
  listAlbums: () => invoke<Album[]>("list_albums"),
  createAlbum: (name: string) => invoke<Album>("create_album", { name }),
  deleteAlbum: (id: number) => invoke<void>("delete_album", { id }),
  checkAlbumNameExists: (name: string, excludeId?: number | null) =>
    invoke<boolean>("check_album_name_exists", {
      name,
      excludeId: excludeId ?? null,
    }),
  renameAlbum: (id: number, name: string) =>
    invoke<Album>("rename_album", { id, name }),
  getFolderAssetCount: (id: number) =>
    invoke<number>("get_folder_asset_count", { id }),
  deleteFolder: (id: number) => invoke<void>("delete_folder", { id }),
  albumAdd: (albumId: number, assetIds: number[]) =>
    invoke<void>("album_add", { albumId, assetIds }),
  albumRemove: (albumId: number, assetIds: number[]) =>
    invoke<void>("album_remove", { albumId, assetIds }),

  getAlbumSummaries: () => invoke<AlbumSummary[]>("get_album_summaries"),
  listTrashAlbums: () => invoke<AlbumSummary[]>("list_trash_albums"),
  restoreAlbum: (id: number) => invoke<void>("restore_album", { id }),
  purgeAlbum: (id: number) => invoke<void>("purge_album", { id }),
  purgeAllTrash: () => invoke<void>("purge_all_trash"),

  // ===== 滤镜预设 CRUD =====
  listPresets: () => invoke<FilterPreset[]>("list_presets"),
  savePreset: (preset: NewFilterPreset) =>
    invoke<FilterPreset>("save_preset", { preset }),
  /** 仅可删用户自定义预设。后端 SQL 强制 `is_builtin=0`，传内置 id 不会报错但也不会删 */
  deletePreset: (id: number) => invoke<void>("delete_preset", { id }),
  listFujiSimulations: () => invoke<string[]>("list_fuji_simulations"),

  // ===== 用户 3D LUT 库 =====
  /** 批量导入 .cube；后端会复制到数据目录、校验合法、入库，单条失败会被跳过 */
  importLuts: (paths: string[]) => invoke<UserLut[]>("import_luts", { paths }),
  /** 扫描目录下所有 .cube 文件并批量导入 */
  importLutsFromDir: (dir: string) => invoke<UserLut[]>("import_luts_from_dir", { dir }),
  listUserLuts: () => invoke<UserLut[]>("list_user_luts"),
  deleteUserLut: (id: number) => invoke<void>("delete_user_lut", { id }),

  /**
   * 渲染单张照片的预览。
   * 后端会先把原图下采样到 `maxEdge`（默认 1280px）再走色彩流水线，
   * 这样滑块拖动时延迟可以控制在 80~150ms。
   */
  getPreview: (assetId: number, settings: FilterSettings | null, maxEdge?: number, token?: number) =>
    invoke<PreviewResult>("get_preview", { assetId, settings, maxEdge, token: token ?? 0 }),

  /** 懒加载 RAW 嵌入原图，优先从数据库缓存读取，返回磁盘绝对路径，用 convertFileSrc(path) 加载。 */
  getRawOriginal: (assetId: number, token?: number) =>
    invoke<string>("get_raw_original", { assetId, token: token ?? 0 }),

  /** 返回封面图缓存目录的绝对路径（macOS 通常为 ~/Library/Application Support/FujiSim/covers）。 */
  getCoverDir: () => invoke<string>("get_cover_dir"),

  setCoverConcurrency: (n: number) =>
    invoke<void>("set_cover_concurrency", { n }),

  /**
   * 启动批量导出。返回新建的 task_id；
   * 实际进度通过 `export:progress` Tauri Event 推送，需要在调用方提前 `listen`。
   */
  startBatchExport: (request: {
    asset_ids: number[];
    filter: FilterSettings;
    export: ExportSettings;
    per_asset_watermark: { asset_id: number; layer: { data: string; width: number; height: number; opacity: number } }[] | null;
    watermark_settings: object | null;
  }) => invoke<number[]>("start_batch_export", { request }),

  getTask: (id: number) => invoke<BatchTask | null>("get_task", { id }),
  listActiveTasksOnStartup: () => invoke<BatchTask[]>("list_active_tasks_on_startup"),
  cancelExportTask: (taskId: number) => invoke<void>("cancel_export_task", { taskId }),
  retryExportTask: (taskId: number, watermarkLayer: { data: string; width: number; height: number; opacity: number } | null) =>
    invoke<void>("retry_export_task", { taskId, watermarkLayer }),
  deleteExportTask: (taskId: number) => invoke<void>("delete_export_task", { taskId }),
  deleteAllExportTasks: (taskIds: number[]) => invoke<void>("delete_all_export_tasks", { taskIds }),
  clearAllData: () => invoke<void>("clear_all_data"),

  // ===== 用户自定义字体库 =====
  importFonts: (paths: string[]) => invoke<UserFont[]>("import_fonts", { paths }),
  listUserFonts: () => invoke<UserFont[]>("list_user_fonts"),
  deleteUserFont: (id: number) => invoke<void>("delete_user_font", { id }),

  // ===== 水印自定义预设 =====
  listWatermarkPresets: () => invoke<WatermarkPreset[]>("list_watermark_presets"),
  createWatermarkPreset: (name: string, settingsJson: string) =>
    invoke<WatermarkPreset>("create_watermark_preset", { name, settingsJson }),
  updateWatermarkPreset: (id: number, name: string, settingsJson: string) =>
    invoke<WatermarkPreset>("update_watermark_preset", { id, name, settingsJson }),
  deleteWatermarkPreset: (id: number) =>
    invoke<void>("delete_watermark_preset", { id }),

  // ===== 应用设置 =====
  /** 取单个设置值，未设置返回 null */
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  /** 写入或更新设置值。value 必须是字符串，复杂类型由调用方 JSON.stringify */
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  /** 删除某项设置 */
  deleteSetting: (key: string) => invoke<void>("delete_setting", { key }),
  /** 一次性获取所有设置，启动时调用 */
  getAllSettings: () => invoke<Record<string, string>>("get_all_settings"),
};

export type { BatchProgress };

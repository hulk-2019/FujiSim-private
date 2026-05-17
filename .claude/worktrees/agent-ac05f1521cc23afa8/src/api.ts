import { invoke } from "@tauri-apps/api/core";
import type {
  Album,
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
  listAssets: (query: AssetQuery = {}) => invoke<Asset[]>("list_assets", { query }),
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
  renameAssets: (ids: number[], template: string) =>
    invoke<Asset[]>("rename_assets", { ids, template }),
  moveAssets: (ids: number[], targetDir: string) =>
    invoke<Asset[]>("move_assets", { ids, targetDir }),

  // ===== 虚拟相册 =====
  listAlbums: () => invoke<Album[]>("list_albums"),
  createAlbum: (name: string) => invoke<Album>("create_album", { name }),
  deleteAlbum: (id: number) => invoke<void>("delete_album", { id }),
  albumAdd: (albumId: number, assetIds: number[]) =>
    invoke<void>("album_add", { albumId, assetIds }),
  albumRemove: (albumId: number, assetIds: number[]) =>
    invoke<void>("album_remove", { albumId, assetIds }),

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
  getPreview: (assetId: number, settings: FilterSettings | null, maxEdge?: number) =>
    invoke<PreviewResult>("get_preview", { assetId, settings, maxEdge }),

  /**
   * 启动批量导出。返回新建的 task_id；
   * 实际进度通过 `export:progress` Tauri Event 推送，需要在调用方提前 `listen`。
   */
  startBatchExport: (request: {
    asset_ids: number[];
    filter: FilterSettings;
    export: ExportSettings;
  }) => invoke<number>("start_batch_export", { request }),

  listRecentTasks: () => invoke<BatchTask[]>("list_recent_tasks"),
  getTask: (id: number) => invoke<BatchTask | null>("get_task", { id }),
};

export type { BatchProgress };

// 防止 release 构建下 Windows 出现额外的控制台窗口（不影响其它平台）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! FujiSim 后端库入口。
//!
//! 这里只做三件事：
//! 1. 装配 `tracing` 日志；
//! 2. 注册 Tauri 插件（对话框、文件系统、Shell）；
//! 3. 在 `setup` 中**同步阻塞**地完成 SQLite 与状态初始化，并把所有 IPC 命令注册到 invoke_handler。
//!
//! 真正的业务逻辑全在以下模块里：
//! - [`db`]：SQLite 连接池、schema、各张表的 Repository
//! - [`asset`]：目录扫描、Exif 解析、文件系统物理操作
//! - [`processing`]：色彩流水线、富士预设、颗粒、LUT
//! - [`export`]：批量导出、水印
//! - [`ipc`]：所有 `#[tauri::command]` 处理函数
//! - [`state`]：应用全局共享状态（连接池、数据目录等）

pub mod asset;
pub mod db;
pub mod error;
pub mod export;
pub mod ipc;
pub mod processing;
pub mod cover_queue;
pub mod queue;
pub mod state;
pub mod vips_io;

/// Tauri 应用主入口。
///
/// 失败场景：如果数据库初始化失败（磁盘写权限、SQLite 损坏等），
/// 错误会通过 `setup` 闭包返回，Tauri 会优雅退出而非 panic。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 安装日志订阅器。`try_init` 而非 `init`：避免在测试环境多次初始化报错。
    // 过滤指令使用 `parse` 而不是 `unwrap`，解析失败则回退到默认 EnvFilter。
    let filter = tracing_subscriber::EnvFilter::from_default_env()
        .add_directive(
            "fujisim=info"
                .parse()
                .expect("内置日志指令必须可解析"),
        );
    tracing_subscriber::fmt().with_env_filter(filter).try_init().ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            use tauri::Manager;
            let state = tauri::async_runtime::block_on(state::AppState::init())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ===== 资产导入 / 查询 =====
            ipc::import_directory,
            ipc::import_files,
            ipc::list_assets,
            ipc::get_asset,
            ipc::library_stats,
            ipc::distinct_cameras,
            ipc::distinct_lenses,
            // ===== 资产打分 / 删除 / 重命名 / 移动 =====
            ipc::set_rating,
            ipc::set_color_label,
            ipc::delete_assets,
            ipc::rename_asset,
            ipc::rename_assets,
            ipc::move_assets,
            // ===== 虚拟相册 =====
            ipc::list_albums,
            ipc::get_album_summaries,
            ipc::list_trash_albums,
            ipc::restore_album,
            ipc::purge_album,
            ipc::purge_all_trash,
            ipc::create_album,
            ipc::delete_album,
            ipc::check_album_name_exists,
            ipc::rename_album,
            ipc::get_folder_asset_count,
            ipc::delete_folder,
            ipc::album_add,
            ipc::album_remove,
            // ===== 滤镜预设 =====
            ipc::list_presets,
            ipc::save_preset,
            ipc::delete_preset,
            // ===== 用户 3D LUT 库 =====
            ipc::import_luts,
            ipc::import_luts_from_dir,
            ipc::list_user_luts,
            ipc::delete_user_lut,
            // ===== 预览 / 批量导出 / 任务历史 =====
            ipc::get_preview,
            ipc::get_raw_original,
            ipc::get_cover_dir,
            ipc::set_cover_concurrency,
            ipc::start_batch_export,
            ipc::get_task,
            ipc::list_fuji_simulations,
            ipc::reset_app_data,
            // ===== 水印自定义预设 =====
            ipc::list_watermark_presets,
            ipc::create_watermark_preset,
            ipc::update_watermark_preset,
            ipc::delete_watermark_preset,
            ipc::list_active_tasks_on_startup,
            ipc::cancel_export_task,
            ipc::retry_export_task,
            ipc::delete_export_task,
            ipc::delete_all_export_tasks,
            ipc::clear_all_data,
            ipc::import_fonts,
            ipc::list_user_fonts,
            ipc::delete_user_font,
            // ===== 应用设置 =====
            ipc::get_setting,
            ipc::set_setting,
            ipc::delete_setting,
            ipc::get_all_settings,
        ])
        .run(tauri::generate_context!())
        .expect("FujiSim 运行时启动失败");
}

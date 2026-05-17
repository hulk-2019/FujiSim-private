use crate::error::Result;
use crate::processing::lut::Lut3D;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// 应用级全局状态。
///
/// 由 Tauri 的 `app.manage(...)` 托管，IPC handler 通过 `State<'_, SharedState>` 取用。
/// 内含：
/// - `pool`：SQLite 连接池，所有数据库访问的入口；
/// - `data_dir`：应用数据根目录（如 macOS `~/Library/Application Support/FujiSim`）；
/// - `thumbnail_dir`：缩略图缓存目录（当前 MVP 阶段未实际生成磁盘缓存，预留）；
/// - `lut_dir`：用户导入的 3D LUT 副本存放目录（`<data_dir>/luts`）；
/// - `lut_cache`：已加载的 LUT 内存缓存，避免每次预览都重新读盘；
/// - `export_pool`：批量导出专用 rayon 线程池，限制并发数防止大图并行 OOM。
pub struct AppState {
    pub pool: SqlitePool,
    pub data_dir: PathBuf,
    pub thumbnail_dir: PathBuf,
    pub lut_dir: PathBuf,
    /// LUT 文件路径 → 已解析的 Lut3D，首次使用时填入，之后复用。
    pub lut_cache: Mutex<HashMap<PathBuf, Arc<Lut3D>>>,
    /// 批量导出专用线程池，最多 2 个并发，防止大图并行处理导致内存溢出。
    pub export_pool: rayon::ThreadPool,
}

/// 共享状态别名。用 `Arc` 包裹以便在 spawn_blocking / rayon 之间廉价克隆。
pub type SharedState = Arc<AppState>;

impl AppState {
    /// 初始化全局状态。在 Tauri `setup` 中以阻塞方式调用一次。
    ///
    /// 步骤：
    /// 1. 解析数据目录（跨平台用 `dirs::data_dir`，找不到则退回当前目录）；
    /// 2. 建好 `data_dir` 与 `thumbnail_dir`；
    /// 3. 打开/创建 SQLite 并同步 schema；
    /// 4. 写入 13 个内置富士预设（重复执行幂等，通过 UPSERT）。
    pub async fn init() -> Result<SharedState> {
        let data_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("FujiSim");
        std::fs::create_dir_all(&data_dir)?;
        let thumbnail_dir = data_dir.join("thumbnails");
        std::fs::create_dir_all(&thumbnail_dir)?;
        let lut_dir = data_dir.join("luts");
        std::fs::create_dir_all(&lut_dir)?;
        let db_path = data_dir.join("library.db");
        let pool = crate::db::init_pool(&db_path).await?;

        // 限制导出并发为 2，防止多张大图同时处理导致内存溢出。
        // 2 个线程在 8 核机器上仍能充分利用 rayon 内部的像素级并行。
        let export_pool = rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .build()
            .map_err(|e| crate::error::AppError::other(e.to_string()))?;

        let state = Arc::new(AppState {
            pool,
            data_dir,
            thumbnail_dir,
            lut_dir,
            lut_cache: Mutex::new(HashMap::new()),
            export_pool,
        });
        seed_builtin_presets(&state.pool).await?;
        Ok(state)
    }
}

/// 把 [`crate::processing::fuji::BUILTIN_NAMES`] 中的每个名字写入 `filter_presets` 表，
/// `is_builtin=1` 标识它们不可被用户删除。
///
/// 这里只写"骨架"——具体的色彩配方在 [`crate::processing::fuji::lookup`] 里硬编码。
/// 也就是说：用户即使误改了 SQLite 中的内置预设字段，下次启动也会被覆盖回出厂默认。
async fn seed_builtin_presets(pool: &SqlitePool) -> Result<()> {
    use crate::db::presets::{upsert, NewFilterPreset};
    for name in crate::processing::fuji::BUILTIN_NAMES {
        let preset = NewFilterPreset {
            name: (*name).to_string(),
            base_simulation: (*name).to_string(),
            grain_effect: None,
            grain_size: None,
            color_chrome_effect: None,
            highlight_tone: 0.0,
            shadow_tone: 0.0,
            color_saturation: 0.0,
            clarity: 0.0,
            sharpness: 0.0,
            wb_shift_r: 0,
            wb_shift_b: 0,
            lut_file_path: None,
            is_builtin: true,
        };
        upsert(pool, &preset).await?;
    }
    Ok(())
}

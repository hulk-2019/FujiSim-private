use crate::error::Result;
use crate::processing::lut::Lut3D;
use crate::queue::TaskQueue;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

pub struct AppState {
    pub pool: SqlitePool,
    pub data_dir: PathBuf,
    pub raw_original_dir: PathBuf,
    pub lut_dir: PathBuf,
    /// 水印层 PNG 文件目录：<data_dir>/watermarks/<task_id>.png
    pub watermark_dir: PathBuf,
    pub cover_dir: PathBuf,
    pub font_dir: PathBuf,
    pub lut_cache: Mutex<HashMap<PathBuf, Arc<Lut3D>>>,
    pub export_pool: Arc<rayon::ThreadPool>,
    pub task_queue: TaskQueue,
    pub cover_queue: Arc<crate::cover_queue::CoverQueue>,
    /// 统一限制缩略图生成和 EXIF 提取的总并发数（固定 4），
    /// 两个 worker 共享同一个信号量，无论同时跑都不超过 4 个 blocking 线程。
    pub io_sem: Arc<Semaphore>,
    /// 导出内存预算（MB）：每个导出任务按 file_size×7 估算内存占用，
    /// 先 CAS 扣减预算再开始处理，完成后归还，防止多张大图同时处理导致 OOM。
    pub export_memory_budget: Arc<AtomicU64>,
    /// 当前预览请求的 token（单调递增）。
    /// 每次 get_preview / get_raw_original 调用时前端传入最新 token，
    /// 后端在 CPU 密集节点检查是否仍是最新值，不是则提前返回 preview_cancelled。
    pub preview_token: Arc<AtomicU64>,
    /// 限制 get_preview 同时只跑 1 个解码任务。
    /// 快速切换时旧请求拿到 permit 后发现 token 过期立即退出，新请求才真正解码，
    /// 避免多个 RAW 解码同时占满 CPU。
    pub preview_sem: Arc<Semaphore>,
}

/// 共享状态别名。用 `Arc` 包裹以便在 spawn_blocking / rayon 之间廉价克隆。
pub type SharedState = Arc<AppState>;

impl AppState {
    /// 初始化全局状态。在 Tauri `setup` 中以阻塞方式调用一次。
    pub async fn init() -> Result<SharedState> {
        let data_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("FujiSim");
        std::fs::create_dir_all(&data_dir)?;
        let raw_original_dir = data_dir.join("raw_originals");
        std::fs::create_dir_all(&raw_original_dir)?;
        let lut_dir = data_dir.join("luts");
        std::fs::create_dir_all(&lut_dir)?;
        let watermark_dir = data_dir.join("watermarks");
        std::fs::create_dir_all(&watermark_dir)?;
        let cover_dir = data_dir.join("covers");
        std::fs::create_dir_all(&cover_dir)?;
        let font_dir = data_dir.join("fonts");
        std::fs::create_dir_all(&font_dir)?;
        let db_path = data_dir.join("library.db");
        let pool = crate::db::init_pool(&db_path).await?;

        let logical_cpus = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);

        // 导出并发：逻辑核心数的一半（最少 2），给系统和预览留出余量
        let export_threads = (logical_cpus / 2).max(2);
        let export_pool = Arc::new(
            rayon::ThreadPoolBuilder::new()
                .num_threads(export_threads)
                .build()
                .map_err(|e| crate::error::AppError::other(e.to_string()))?,
        );

        let budget_mb: u64 = 1600;

        let state = Arc::new(AppState {
            pool,
            data_dir,
            raw_original_dir,
            lut_dir,
            watermark_dir,
            cover_dir,
            font_dir,
            lut_cache: Mutex::new(HashMap::new()),
            export_pool,
            task_queue: TaskQueue::new(2),
            cover_queue: Arc::new(crate::cover_queue::CoverQueue::new(
                (logical_cpus / 2).max(2),
            )),
            // 缩略图生成和 EXIF 提取共享信号量，总并发固定 4
            io_sem: Arc::new(Semaphore::new(4)),
            export_memory_budget: Arc::new(AtomicU64::new(budget_mb)),
            preview_token: Arc::new(AtomicU64::new(0)),
            preview_sem: Arc::new(Semaphore::new(1)),
        });
        seed_builtin_presets(&state.pool).await?;
        Ok(state)
    }
}

/// 把 [`crate::processing::fuji::BUILTIN_NAMES`] 中的每个名字写入 `filter_presets` 表，
/// `is_builtin=1` 标识它们不可被用户删除。
async fn seed_builtin_presets(pool: &SqlitePool) -> Result<()> {
    use crate::db::presets::{upsert, NewFilterPreset};
    for name in crate::processing::fuji::BUILTIN_NAMES {
        let preset = NewFilterPreset {
            name: (*name).to_string(),
            base_simulation: (*name).to_string(),
            grain_effect: None,
            grain_size: None,
            color_chrome_effect: None,
            exposure: 0.0,
            contrast: 0,
            brightness: 0,
            highlight_tone: 0,
            shadow_tone: 0,
            white: 0,
            black: 0,
            dehaze: 0,
            vibrance: 0,
            color_saturation: 0,
            clarity: 0,
            sharpness: 0,
            wb_shift_r: 0,
            wb_shift_b: 0,
            lut_file_path: None,
            category_id: None,
            is_builtin: true,
        };
        upsert(pool, &preset).await?;
    }
    Ok(())
}

use crate::error::Result;
use crate::processing::lut::Lut3D;
use crate::queue::TaskQueue;
use image::{ImageBuffer, Rgb};
use sqlx::SqlitePool;
use std::collections::HashMap;
use indexmap::IndexMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;
use std::sync::atomic::AtomicU64;

/// 预览底图缓存 key：(资产 id, 下采样长边像素数)
type PreviewCacheKey = (i64, u32);

pub struct AppState {
    pub pool: SqlitePool,
    pub data_dir: PathBuf,
    pub thumbnail_dir: PathBuf,
    pub lut_dir: PathBuf,
    /// 水印层 PNG 文件目录：<data_dir>/watermarks/<task_id>.png
    pub watermark_dir: PathBuf,
    pub cover_dir: PathBuf,
    pub font_dir: PathBuf,
    pub preview_cache_dir: PathBuf,
    pub lut_cache: Mutex<HashMap<PathBuf, Arc<Lut3D>>>,
    pub export_pool: Arc<rayon::ThreadPool>,
    /// 预览渲染专用线程池，与导出线程池隔离，避免导出任务阻塞 UI 预览响应
    pub preview_pool: Arc<rayon::ThreadPool>,
    pub task_queue: TaskQueue,
    pub cover_queue: Arc<crate::cover_queue::CoverQueue>,
    /// 统一限制缩略图生成和 EXIF 提取的总并发数（固定 4），
    /// 两个 worker 共享同一个信号量，无论同时跑都不超过 4 个 blocking 线程。
    pub io_sem: Arc<Semaphore>,
    /// 限制同时进行 RAW 解码的预览请求数（固定 2），
    /// 防止快速切换照片时大量 LibRaw 解码任务同时跑满 CPU。
    pub preview_sem: Arc<Semaphore>,
    /// 下采样后的预览底图缓存（16-bit RGB，约 6.5MB/张）。
    /// 调整滤镜参数时命中缓存可完全跳过磁盘 IO 和 RAW 解码，仅跑色彩流水线。
    /// LRU 简化为最多保留 4 张，key = (asset_id, max_edge)。
    pub preview_cache: Arc<Mutex<IndexMap<PreviewCacheKey, Arc<ImageBuffer<Rgb<u16>, Vec<u16>>>>>>,
    /// 导出内存预算（MB）：每个导出任务按 file_size×7 估算内存占用，
    /// 先 CAS 扣减预算再开始处理，完成后归还，防止多张大图同时处理导致 OOM。
    pub export_memory_budget: Arc<AtomicU64>,
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
        let watermark_dir = data_dir.join("watermarks");
        std::fs::create_dir_all(&watermark_dir)?;
        let cover_dir = data_dir.join("covers");
        std::fs::create_dir_all(&cover_dir)?;
        let font_dir = data_dir.join("fonts");
        std::fs::create_dir_all(&font_dir)?;
        let preview_cache_dir = data_dir.join("preview_cache");
        std::fs::create_dir_all(&preview_cache_dir)?;
        let db_path = data_dir.join("library.db");
        let pool = crate::db::init_pool(&db_path).await?;

        let logical_cpus = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);

        // 导出并发：逻辑核心数 - 1（最少 2），配合内存预算系统动态控制实际并发
        let export_threads = (logical_cpus.saturating_sub(1)).max(2);
        let export_pool = Arc::new(
            rayon::ThreadPoolBuilder::new()
                .num_threads(export_threads)
                .build()
                .map_err(|e| crate::error::AppError::other(e.to_string()))?,
        );

        // 预览线程池：取逻辑核心数的一半（最少 2），与导出池隔离
        let preview_threads = (logical_cpus / 2).max(2);
        let preview_pool = Arc::new(
            rayon::ThreadPoolBuilder::new()
                .num_threads(preview_threads)
                .build()
                .map_err(|e| crate::error::AppError::other(e.to_string()))?,
        );

        let budget_mb: u64 = 1600;

        let state = Arc::new(AppState {
            pool,
            data_dir,
            thumbnail_dir,
            lut_dir,
            watermark_dir,
            cover_dir,
            font_dir,
            preview_cache_dir,
            lut_cache: Mutex::new(HashMap::new()),
            export_pool,
            preview_pool,
            task_queue: TaskQueue::new(2),
            cover_queue: Arc::new(crate::cover_queue::CoverQueue::new(
                (logical_cpus / 2).max(2),
            )),
            // 缩略图生成和 EXIF 提取共享信号量，总并发固定 4
            io_sem: Arc::new(Semaphore::new(4)),
            // RAW 解码并发上限 2，防止快速切换时 CPU 急升
            preview_sem: Arc::new(Semaphore::new(2)),
            preview_cache: Arc::new(Mutex::new(IndexMap::new())),
            export_memory_budget: Arc::new(AtomicU64::new(budget_mb)),
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

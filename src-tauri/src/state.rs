use crate::error::Result;
use crate::processing::gpu::context::GpuContext;
use crate::processing::lut::Lut3D;
use crate::queue::TaskQueue;
use image::{ImageBuffer, Rgb};
use sqlx::SqlitePool;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

pub type Rgb16Image = ImageBuffer<Rgb<u16>, Vec<u16>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PreviewBaseCacheKey {
    pub asset_id: i64,
    pub max_edge: Option<u32>,
}

pub struct PreviewBaseCache {
    max_items: usize,
    order: VecDeque<PreviewBaseCacheKey>,
    map: HashMap<PreviewBaseCacheKey, Arc<Rgb16Image>>,
}

impl PreviewBaseCache {
    pub fn new(max_items: usize) -> Self {
        Self {
            max_items,
            order: VecDeque::new(),
            map: HashMap::new(),
        }
    }

    pub fn get(&mut self, key: PreviewBaseCacheKey) -> Option<Arc<Rgb16Image>> {
        let img = self.map.get(&key)?.clone();
        self.touch(key);
        Some(img)
    }

    pub fn insert(&mut self, key: PreviewBaseCacheKey, img: Arc<Rgb16Image>) {
        if self.map.contains_key(&key) {
            self.map.insert(key, img);
            self.touch(key);
            return;
        }

        self.map.insert(key, img);
        self.order.push_back(key);

        while self.map.len() > self.max_items {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.map.remove(&oldest);
        }
    }

    pub fn clear(&mut self) {
        self.order.clear();
        self.map.clear();
    }

    fn touch(&mut self, key: PreviewBaseCacheKey) {
        self.order.retain(|k| *k != key);
        self.order.push_back(key);
    }
}

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
    pub preview_base_cache: Mutex<PreviewBaseCache>,
    pub preview_pool: Arc<rayon::ThreadPool>,
    pub export_pool: Arc<rayon::ThreadPool>,
    /// 全局 GPU 上下文。Tauri setup 阶段一次性初始化，进程生命周期内长存。
    pub gpu: Arc<GpuContext>,
    pub task_queue: TaskQueue,
    pub cover_queue: Arc<crate::cover_queue::CoverQueue>,
    /// 统一限制缩略图生成和 EXIF 提取的总并发数（固定 4），
    /// 两个 worker 共享同一个信号量，无论同时跑都不超过 4 个 blocking 线程。
    pub io_sem: Arc<Semaphore>,
    /// 导出内存预算（MB）：每个导出任务按 file_size×7 估算内存占用，
    /// 先 CAS 扣减预算再开始处理，完成后归还，防止多张大图同时处理导致 OOM。
    pub export_memory_budget: Arc<AtomicU64>,
    /// 当前预览请求的 token（单调递增）。
    /// 每次 get_preview 调用时前端传入最新 token，
    /// 后端在 CPU 密集节点检查是否仍是最新值，不是则提前返回 preview_cancelled。
    pub preview_token: Arc<AtomicU64>,
    /// 限制 get_preview 同时只跑 1 个解码任务。
    /// 快速切换时旧请求拿到 permit 后发现 token 过期立即退出，新请求才真正解码，
    /// 避免多个 RAW 解码同时占满 CPU。
    pub preview_sem: Arc<Semaphore>,
    /// 当前直方图请求的 token（单调递增）。与 preview_token 平行，
    /// compute_histogram 在解码完成后检查是否仍是最新值，
    /// 不是则返回 preview_cancelled，前端静默丢弃。
    /// 不复用 preview_token 是因为两条通道共用 token 会互相误杀。
    pub histogram_token: Arc<AtomicU64>,
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
        cleanup_legacy_raw_cache(&raw_original_dir);
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

        // 预览线程池和导出线程池分离，避免批量导出占满 rayon worker 后阻塞交互预览。
        let preview_threads = 2.min(logical_cpus.max(1));
        let preview_pool = Arc::new(
            rayon::ThreadPoolBuilder::new()
                .num_threads(preview_threads)
                .thread_name(|i| format!("preview-{i}"))
                .build()
                .map_err(|e| crate::error::AppError::other(e.to_string()))?,
        );

        // 导出默认串行执行。导出是后台吞吐任务，不能默认和交互预览抢 CPU/GPU/IO。
        let export_threads = (logical_cpus / 2).max(1);
        let export_pool = Arc::new(
            rayon::ThreadPoolBuilder::new()
                .num_threads(export_threads)
                .thread_name(|i| format!("export-{i}"))
                .build()
                .map_err(|e| crate::error::AppError::other(e.to_string()))?,
        );

        let budget_mb: u64 = 1600;

        let gpu = Arc::new(GpuContext::new().await?);

        let state = Arc::new(AppState {
            pool,
            data_dir,
            raw_original_dir,
            lut_dir,
            watermark_dir,
            cover_dir,
            font_dir,
            lut_cache: Mutex::new(HashMap::new()),
            preview_base_cache: Mutex::new(PreviewBaseCache::new(8)),
            preview_pool,
            export_pool,
            gpu,
            task_queue: TaskQueue::new(1),
            cover_queue: Arc::new(crate::cover_queue::CoverQueue::new(1)),
            // 缩略图生成和 EXIF 提取共享信号量，总并发固定 4
            io_sem: Arc::new(Semaphore::new(4)),
            export_memory_budget: Arc::new(AtomicU64::new(budget_mb)),
            preview_token: Arc::new(AtomicU64::new(0)),
            preview_sem: Arc::new(Semaphore::new(1)),
            histogram_token: Arc::new(AtomicU64::new(0)),
        });

        // Populate the global GPU OnceCell so process_image routes through GPU.
        crate::processing::set_global_gpu(state.gpu.clone());

        seed_builtin_presets(&state.pool).await?;
        Ok(state)
    }
}

fn cleanup_legacy_raw_cache(dir: &PathBuf) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let is_legacy_raw_cache =
            name.ends_with(".jpg") || (name.ends_with(".tif") && !name.ends_with("_baseline.tif"));
        if is_legacy_raw_cache {
            let _ = std::fs::remove_file(path);
        }
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
            grain_amount: 0.0,
            grain_size: 0.0,
            grain_roughness: 0.0,
            grain_color: 0.0,
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

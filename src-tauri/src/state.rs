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

    pub fn remove_asset(&mut self, asset_id: i64) {
        self.order.retain(|k| k.asset_id != asset_id);
        self.map.retain(|k, _| k.asset_id != asset_id);
    }

    fn touch(&mut self, key: PreviewBaseCacheKey) {
        self.order.retain(|k| *k != key);
        self.order.push_back(key);
    }
}

pub struct AppState {
    pub pool: SqlitePool,
    pub data_dir: PathBuf,
    pub lut_dir: PathBuf,
    /// 水印层 PNG 文件目录：<data_dir>/watermarks/<task_id>.png
    pub watermark_dir: PathBuf,
    /// 项目汇总页封面缓存目录：<data_dir>/project_covers/<asset_id>.jpg
    pub project_cover_dir: PathBuf,
    pub font_dir: PathBuf,
    pub lut_cache: Mutex<HashMap<PathBuf, Arc<Lut3D>>>,
    pub preview_base_cache: Mutex<PreviewBaseCache>,
    pub preview_pool: Arc<rayon::ThreadPool>,
    pub export_pool: Arc<rayon::ThreadPool>,
    /// 全局 GPU 上下文。Tauri setup 阶段一次性初始化，进程生命周期内长存。
    pub gpu: Arc<GpuContext>,
    pub task_queue: TaskQueue,
    /// 统一限制缩略图读取和 EXIF 提取的总并发数（固定 4）。
    pub io_sem: Arc<Semaphore>,
    /// 导出内存预算（MB）：每个导出任务按 file_size×7 估算内存占用，
    /// 先 CAS 扣减预算再开始处理，完成后归还，防止多张大图同时处理导致 OOM。
    pub export_memory_budget: Arc<AtomicU64>,
    /// 当前预览请求的 token（单调递增）。
    /// 每次 get_preview 调用时前端传入最新 token，
    /// 后端在 CPU 密集节点检查是否仍是最新值，不是则提前返回 preview_cancelled。
    pub preview_token: Arc<AtomicU64>,
    /// 当前 tile 细节请求的 token。Tile 与主预览分离，避免多 tile refinement
    /// 互相取消主预览；主预览更新时仍会打断旧 tile。
    pub tile_token: Arc<AtomicU64>,
    /// Millisecond epoch until which interactive preview work should be treated as active.
    /// Lower-priority queues use this to avoid starting new CPU/IO-heavy jobs while the
    /// editor is rendering the focused image.
    pub preview_active_until_ms: Arc<AtomicU64>,
    /// Millisecond epoch until which the editor should be considered actively
    /// interacting even if frontend WebGL is handling the visual feedback.
    pub interaction_active_until_ms: Arc<AtomicU64>,
    /// 限制 get_preview 同时只跑 1 个解码任务。
    /// 快速切换时旧请求拿到 permit 后发现 token 过期立即退出，新请求才真正解码，
    /// 避免多个 RAW 解码同时占满 CPU。
    pub preview_sem: Arc<Semaphore>,
    /// 限制 tile refinement 的并发。Tile 不再占用主预览信号量，
    /// 但仍保持低并发，避免高倍缩放时同时处理过多局部图块。
    pub tile_sem: Arc<Semaphore>,
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
        let lut_dir = data_dir.join("luts");
        std::fs::create_dir_all(&lut_dir)?;
        let watermark_dir = data_dir.join("watermarks");
        std::fs::create_dir_all(&watermark_dir)?;
        let project_cover_dir = data_dir.join("project_covers");
        std::fs::create_dir_all(&project_cover_dir)?;
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
            lut_dir,
            watermark_dir,
            project_cover_dir,
            font_dir,
            lut_cache: Mutex::new(HashMap::new()),
            preview_base_cache: Mutex::new(PreviewBaseCache::new(8)),
            preview_pool,
            export_pool,
            gpu,
            task_queue: TaskQueue::new(1),
            // 缩略图读取和 EXIF 提取共享信号量，总并发固定 4
            io_sem: Arc::new(Semaphore::new(4)),
            export_memory_budget: Arc::new(AtomicU64::new(budget_mb)),
            preview_token: Arc::new(AtomicU64::new(0)),
            tile_token: Arc::new(AtomicU64::new(0)),
            preview_active_until_ms: Arc::new(AtomicU64::new(0)),
            interaction_active_until_ms: Arc::new(AtomicU64::new(0)),
            preview_sem: Arc::new(Semaphore::new(1)),
            tile_sem: Arc::new(Semaphore::new(2)),
            histogram_token: Arc::new(AtomicU64::new(0)),
        });

        // Populate the global GPU OnceCell so process_image routes through GPU.
        crate::processing::set_global_gpu(state.gpu.clone());

        seed_builtin_presets(&state.pool).await?;
        Ok(state)
    }

    pub fn mark_preview_active_for(&self, duration_ms: u64) {
        let until = now_ms().saturating_add(duration_ms);
        self.preview_active_until_ms
            .fetch_max(until, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn preview_is_active(&self) -> bool {
        self.preview_active_until_ms
            .load(std::sync::atomic::Ordering::SeqCst)
            > now_ms()
    }

    pub fn mark_interaction_active_for(&self, duration_ms: u64) {
        let until = now_ms().saturating_add(duration_ms);
        self.interaction_active_until_ms
            .fetch_max(until, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn interaction_is_active(&self) -> bool {
        self.interaction_active_until_ms
            .load(std::sync::atomic::Ordering::SeqCst)
            > now_ms()
    }

    pub fn low_priority_work_can_start(&self) -> bool {
        !self.preview_is_active() && !self.interaction_is_active()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

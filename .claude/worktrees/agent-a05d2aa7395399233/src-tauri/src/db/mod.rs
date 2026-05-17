use crate::error::Result;
use sqlx::sqlite::{SqlitePoolOptions, SqliteConnectOptions};
use sqlx::{ConnectOptions, SqlitePool};
use std::path::Path;
use std::str::FromStr;

pub mod assets;
pub mod albums;
pub mod presets;
pub mod tasks;
pub mod user_luts;

/// 创建（或打开）SQLite 数据库连接池。
///
/// - 自动建库（`create_if_missing`）；
/// - 启用 WAL 模式：写并发更友好，预览/导入时不会卡住 UI 查询；
/// - 启用外键约束：保证 `album_assets` 这类关联表的引用一致性；
/// - 同步级别 Normal：在保留 fsync 安全的前提下加速插入（适合本地工具）；
/// - 连接池最多 8 个连接，足以支撑前端并发请求。
///
/// 接受 `&Path` 而不是 `&PathBuf`，让调用方既能传 `PathBuf` 也能传字面量路径。
pub async fn init_pool(db_path: &Path) -> Result<SqlitePool> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .foreign_keys(true)
        .log_statements(tracing::log::LevelFilter::Debug);

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;

    run_migrations(&pool).await?;
    Ok(pool)
}

/// 把 schema 同步到数据库。
///
/// 当前实现是把整个 schema 作为一个 `CREATE TABLE IF NOT EXISTS` 脚本一次性执行，
/// 适合 MVP 阶段。未来加表/改字段时建议改用 sqlx migrations 目录。
async fn run_migrations(pool: &SqlitePool) -> Result<()> {
    sqlx::query(SCHEMA).execute(pool).await?;
    Ok(())
}

/// 全部 6 张业务表的 schema。
///
/// 设计要点：
/// - 所有外键都加 `ON DELETE CASCADE`，删相册时自动断开关联，删资产时自动清除其生成记录；
/// - 字段命名与 `db/*.rs` 里的 `FromRow` 结构严格对齐；
/// - 关键查询字段（拍摄时间、相机、星级）建了索引，10000+ 资产网格滚动也不卡。
const SCHEMA: &str = r#"
-- 资产主表：每一行对应硬盘上的一个图片文件，不存储像素只存元数据
CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,        -- 物理路径，UNIQUE 防止重复导入
    file_name TEXT NOT NULL,
    file_type TEXT,                        -- 大写扩展名，例如 'JPEG' / 'ARW'
    file_size INTEGER,
    date_taken TEXT,                       -- 拍摄时间（'YYYY-MM-DD HH:MM:SS'，从 Exif 提取）
    camera_make TEXT,
    camera_model TEXT,
    lens_model TEXT,
    iso INTEGER,
    f_number REAL,
    shutter_speed TEXT,                    -- 文本形式，避免 1/125 这类有理数表达困难
    focal_length REAL,
    star_rating INTEGER NOT NULL DEFAULT 0, -- 0-5，0 代表未评分
    color_label TEXT,                      -- 颜色标签（red/yellow/green/blue/purple）
    width INTEGER,
    height INTEGER,
    is_raw INTEGER NOT NULL DEFAULT 0,     -- 布尔位，1=RAW 文件
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assets_date ON assets(date_taken);
CREATE INDEX IF NOT EXISTS idx_assets_camera ON assets(camera_model);
CREATE INDEX IF NOT EXISTS idx_assets_rating ON assets(star_rating);

-- 虚拟相册：纯逻辑分组，不影响物理文件
CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 相册 ↔ 资产 多对多关联
CREATE TABLE IF NOT EXISTS album_assets (
    album_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    PRIMARY KEY (album_id, asset_id),
    FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- 滤镜预设表：既存放 13 个内置富士预设（is_builtin=1，不可删），也存放用户自定义预设
CREATE TABLE IF NOT EXISTS filter_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    base_simulation TEXT NOT NULL,         -- 基础胶片模拟名称（Provia/Velvia/...）
    grain_effect TEXT,                     -- None / Weak / Medium / Strong
    grain_size TEXT,                       -- Small / Large
    color_chrome_effect TEXT,              -- None / Weak / Strong
    highlight_tone REAL NOT NULL DEFAULT 0,
    shadow_tone REAL NOT NULL DEFAULT 0,
    color_saturation REAL NOT NULL DEFAULT 0,
    clarity REAL NOT NULL DEFAULT 0,
    sharpness REAL NOT NULL DEFAULT 0,
    wb_shift_r INTEGER NOT NULL DEFAULT 0, -- 白平衡偏移 R 轴：-9..+9
    wb_shift_b INTEGER NOT NULL DEFAULT 0, -- 白平衡偏移 B 轴：-9..+9
    lut_file_path TEXT,                    -- 外挂 .cube LUT 路径
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 批量导出任务：一行 = 一次"导出 N 张"操作
CREATE TABLE IF NOT EXISTS batch_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL,                  -- Processing / Completed / Failed
    total INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    export_settings_json TEXT NOT NULL,    -- 完整序列化的 ExportSettings
    filter_settings_json TEXT NOT NULL,    -- 完整序列化的 FilterSettings
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

-- 用户批量导入的 3D LUT 库。file_path 指向应用数据目录 luts/ 下的副本
CREATE TABLE IF NOT EXISTS user_luts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 单张资产的生成记录：用于"哪一张失败了、错误信息是什么、输出到哪了"
CREATE TABLE IF NOT EXISTS asset_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    output_path TEXT,
    status TEXT NOT NULL,                  -- Success / Error
    error_message TEXT,
    FOREIGN KEY (task_id) REFERENCES batch_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);
"#;

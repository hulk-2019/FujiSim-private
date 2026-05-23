use crate::error::Result;
use sqlx::sqlite::{SqlitePoolOptions, SqliteConnectOptions};
use sqlx::{ConnectOptions, SqlitePool};
use std::path::Path;
use std::str::FromStr;

pub mod assets;
pub mod albums;
pub mod presets;
pub mod tasks;
pub mod user_fonts;
pub mod user_luts;
pub mod watermark_presets;
pub mod app_settings;

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
async fn run_migrations(pool: &SqlitePool) -> Result<()> {
    sqlx::query(SCHEMA).execute(pool).await?;
    // 增量迁移：补充新列（列已存在时 ALTER TABLE 会报错，直接忽略）
    for sql in [
        "ALTER TABLE batch_tasks ADD COLUMN asset_ids_json TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE batch_tasks ADD COLUMN watermark_json TEXT",
        "ALTER TABLE batch_tasks ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE batch_tasks ADD COLUMN deleted_at TEXT",
        "ALTER TABLE user_luts ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE user_luts ADD COLUMN deleted_at TEXT",
        "ALTER TABLE watermark_presets ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE watermark_presets ADD COLUMN deleted_at TEXT",
        "ALTER TABLE assets ADD COLUMN exif_extracted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE assets ADD COLUMN file_mtime INTEGER",
        "ALTER TABLE assets ADD COLUMN preview_path TEXT",
        "ALTER TABLE assets ADD COLUMN cover_path TEXT",
        "ALTER TABLE albums ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE albums ADD COLUMN deleted_at TEXT",
    ] {
        let _ = sqlx::query(sql).execute(pool).await;
    }
    // 删除冗余列：completed/failed 改由 asset_generations 聚合计算；
    // display_width/display_height 已废弃，width/height 直接存储实际像素尺寸。
    // SQLite 3.35+ 支持 DROP COLUMN；旧版本会报错，忽略即可（列留着不影响正确性）
    for sql in [
        "ALTER TABLE batch_tasks DROP COLUMN completed",
        "ALTER TABLE batch_tasks DROP COLUMN failed",
        "ALTER TABLE assets DROP COLUMN display_width",
        "ALTER TABLE assets DROP COLUMN display_height",
        "ALTER TABLE batch_tasks DROP COLUMN watermark_layer_json",
        "ALTER TABLE assets DROP COLUMN thumbnail_path",
    ] {
        let _ = sqlx::query(sql).execute(pool).await;
    }

    // 状态值迁移：旧版本使用 PascalCase，新版本统一为 lowercase。
    // 应用重启时所有 processing 任务实际上已中断，重置为 pending 以便队列重新调度。
    for sql in [
        "ALTER TABLE batch_tasks ADD COLUMN watermark_layer_path TEXT",
        "UPDATE batch_tasks SET status = 'pending'    WHERE status IN ('Processing', 'processing')",
        "UPDATE batch_tasks SET status = 'done'       WHERE status IN ('Completed')",
        "UPDATE batch_tasks SET status = 'error'      WHERE status IN ('Failed')",
        "UPDATE batch_tasks SET status = 'cancelled'  WHERE status IN ('Cancelled')",
    ] {
        let _ = sqlx::query(sql).execute(pool).await;
    }

    // asset_ids_json → asset_id 迁移：
    // 1. 先加 asset_id 列（nullable，旧行暂时为 NULL）
    // 2. 用 json_each 把旧行按 JSON 数组拆成多行新行（asset_id 有值）
    // 3. 删除旧行（asset_id IS NULL 的行）和旧列
    let has_old_col: bool = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('batch_tasks') WHERE name='asset_ids_json'"
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0i64) > 0;

    let has_new_col: bool = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('batch_tasks') WHERE name='asset_id'"
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0i64) > 0;

    // 先确保 asset_id 列存在（已存在时 ALTER TABLE 会报错，忽略即可）
    if !has_new_col {
        let _ = sqlx::query("ALTER TABLE batch_tasks ADD COLUMN asset_id INTEGER")
            .execute(pool).await;
    }

    if has_old_col {
        // 用 json_each 把每条旧任务拆成多行写入新格式（asset_id 有值的新行）
        let _ = sqlx::query(r#"
            INSERT INTO batch_tasks
                (status, asset_id, total, export_settings_json, filter_settings_json,
                 watermark_json, watermark_layer_path, created_at, completed_at,
                 is_deleted, deleted_at)
            SELECT
                bt.status,
                CAST(je.value AS INTEGER),
                1,
                bt.export_settings_json,
                bt.filter_settings_json,
                bt.watermark_json,
                bt.watermark_layer_path,
                bt.created_at,
                bt.completed_at,
                bt.is_deleted,
                bt.deleted_at
            FROM batch_tasks bt, json_each(bt.asset_ids_json) je
            WHERE bt.asset_ids_json IS NOT NULL AND bt.asset_ids_json != '[]'
              AND CAST(je.value AS INTEGER) IN (SELECT id FROM assets)
        "#).execute(pool).await;

        // 删除 asset_id 为 NULL 的旧行（原始 asset_ids_json 格式的行）
        let _ = sqlx::query("DELETE FROM batch_tasks WHERE asset_id IS NULL")
            .execute(pool).await;

        // 删除旧列
        let _ = sqlx::query("ALTER TABLE batch_tasks DROP COLUMN asset_ids_json")
            .execute(pool).await;
    }

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS app_settings (
            key        TEXT PRIMARY KEY NOT NULL,
            value      TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

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

-- 批量导出任务：一行 = 一张资产的一次导出操作
CREATE TABLE IF NOT EXISTS batch_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL,                  -- pending / processing / cancelled / done / error
    asset_id INTEGER NOT NULL,             -- 关联资产
    total INTEGER NOT NULL DEFAULT 1,
    export_settings_json TEXT NOT NULL,    -- 完整序列化的 ExportSettings
    filter_settings_json TEXT NOT NULL,    -- 完整序列化的 FilterSettings
    watermark_json TEXT,                   -- WatermarkSettings JSON（可为 NULL）
    watermark_layer_path TEXT,             -- 水印层 PNG 文件路径
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- 用户批量导入的 3D LUT 库。file_path 指向应用数据目录 luts/ 下的副本
CREATE TABLE IF NOT EXISTS user_luts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
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

-- 水印自定义预设：settings_json 存一个完整的 WatermarkSettings 序列化串
CREATE TABLE IF NOT EXISTS watermark_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);

-- 用户导入的自定义字体库。file_path 指向应用数据目录 fonts/ 下的副本
CREATE TABLE IF NOT EXISTS user_fonts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    ext TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);
"#;

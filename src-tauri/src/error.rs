use thiserror::Error;

/// 全局 `Result` 别名，模块内默认使用，省去到处写 `std::result::Result`。
pub type Result<T> = std::result::Result<T, AppError>;

/// FotoForge 后端的统一错误类型。
///
/// 设计原则：
/// - **按底层来源分桶**：IO、SQL、图像、Exif 等各占一个 variant，便于 `match` 时分别处理；
/// - **可序列化**：实现了 `serde::Serialize`，Tauri IPC 直接把 `AppError` 通过 `Result<T, AppError>`
///   传给前端 JS，错误字符串就是 `Display` 输出，前端 `catch` 拿到的是可读字符串；
/// - **`#[from]`** 让 `?` 操作符可以自动把第三方错误向上传播。
#[derive(Debug, Error)]
pub enum AppError {
    /// 文件系统、网络等 std::io 错误（创建目录、读写文件失败等）
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// SQLite 运行时错误（SQL 语法、唯一约束冲突、连接超时等）
    #[error("db: {0}")]
    Db(#[from] sqlx::Error),

    /// 数据库迁移失败（保留位，目前 schema 用 IF NOT EXISTS 不依赖 migrate）
    #[error("migrate: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    /// Exif 解析失败（坏文件、不支持的标签等）
    #[error("exif: {0}")]
    Exif(#[from] exif::Error),

    /// 目录遍历失败（权限不足、目标不存在等）
    #[error("walkdir: {0}")]
    Walkdir(#[from] walkdir::Error),

    /// 移入系统回收站失败
    #[error("trash: {0}")]
    Trash(#[from] trash::Error),

    /// JSON 序列化/反序列化失败
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    /// Tauri 框架自身错误（窗口创建、Event 发送等）
    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),

    /// 业务层 "找不到" 错误：被请求的资产/相册/预设等不存在
    #[error("not found: {0}")]
    NotFound(String),

    /// 不支持的文件格式（例如 MVP 阶段尚未启用的 RAW）
    #[error("unsupported format: {0}")]
    Unsupported(String),

    /// libvips 操作失败（解码、变换、写出等）
    #[error("vips: {0}")]
    Vips(String),

    /// 兜底错误，用于无法归类到上面任一桶的业务异常
    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// 便利构造器：`AppError::other("xxx")` 或 `AppError::other(format!(...))`
    pub fn other(msg: impl Into<String>) -> Self {
        AppError::Other(msg.into())
    }
}

/// Tauri IPC 要求错误类型必须实现 `Serialize`。
///
/// 这里把任意 variant 序列化成统一的字符串（即 `Display` 输出），
/// 前端 JS 端在 `catch` 里直接拿到一句可读消息，不需要再做类型判断。
impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

use crate::error::{AppError, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

/// 资产表的"读模型"：与 `assets` 表字段一一对应，用于查询。
///
/// 字段类型用 `i64`/`Option<String>`/`f64` 而非更精确的类型，是因为 SQLite
/// 弱类型语义下 `FromRow` 在原生类型映射时最稳。
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Asset {
    pub id: i64,
    pub file_path: String,
    pub file_name: String,
    pub file_type: Option<String>,
    pub file_size: Option<i64>,
    pub date_taken: Option<String>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub iso: Option<i64>,
    pub f_number: Option<f64>,
    pub shutter_speed: Option<String>,
    pub focal_length: Option<f64>,
    pub star_rating: i64,
    pub color_label: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// SQLite 没有布尔类型，用 0/1 整数代替。前端类型 `is_raw: number`。
    pub is_raw: i64,
    pub created_at: String,
    pub cover_path: Option<String>,
}

/// 写模型：插入前不需要 `id` 与 `created_at`（由数据库自动生成）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewAsset {
    pub file_path: String,
    pub file_name: String,
    pub file_type: Option<String>,
    pub file_size: Option<i64>,
    pub date_taken: Option<String>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub iso: Option<i64>,
    pub f_number: Option<f64>,
    pub shutter_speed: Option<String>,
    pub focal_length: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// 写模型里允许使用真正的 `bool`，写入时再转 0/1。
    pub is_raw: bool,
}

/// 查询条件。所有字段都是 `Option`，前端可以"按需带"。
///
/// 多个条件之间是 AND；`search` 字段同时匹配文件名/相机/镜头模糊。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AssetQuery {
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub min_rating: Option<i64>,
    pub color_label: Option<String>,
    pub min_iso: Option<i64>,
    pub max_iso: Option<i64>,
    pub project_id: Option<i64>,
    pub search: Option<String>,
    #[serde(default)]
    pub sort_by: SortBy,
    #[serde(default)]
    pub sort_dir: SortDir,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// 排序字段。与前端 `AssetQuery['sort_by']` 字符串字面量严格对齐。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortBy {
    #[default]
    DateTaken,
    FileName,
    CameraModel,
    LensModel,
    Iso,
    StarRating,
    CreatedAt,
}

/// 排序方向。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDir {
    Asc,
    #[default]
    Desc,
}

/// 批量插入资产。
///
/// 使用单个事务包裹整批，避免每条 INSERT 都 fsync，导入 1000 张 JPEG 通常在 1 秒以内。
/// `ON CONFLICT(file_path) DO UPDATE` 在重复导入时会刷新元数据/尺寸字段（如旧版本未解析 RAW
/// 时入库的空值，再次扫描就能补上），但用户编辑过的 star_rating/color_label 不会被覆盖。
pub async fn insert_many(pool: &SqlitePool, items: &[NewAsset]) -> Result<usize> {
    if items.is_empty() {
        return Ok(0);
    }
    let mut tx = pool.begin().await?;
    let mut inserted = 0usize;
    for a in items {
        let res = sqlx::query(
            r#"INSERT INTO assets (file_path,file_name,file_type,file_size,date_taken,camera_make,camera_model,lens_model,iso,f_number,shutter_speed,focal_length,width,height,is_raw)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(file_path) DO UPDATE SET
                 file_name = excluded.file_name,
                 file_type = excluded.file_type,
                 file_size = excluded.file_size,
                 date_taken = excluded.date_taken,
                 camera_make = excluded.camera_make,
                 camera_model = excluded.camera_model,
                 lens_model = excluded.lens_model,
                 iso = excluded.iso,
                 f_number = excluded.f_number,
                 shutter_speed = excluded.shutter_speed,
                 focal_length = excluded.focal_length,
                 width = excluded.width,
                 height = excluded.height,
                 is_raw = excluded.is_raw"#,
        )
        .bind(&a.file_path)
        .bind(&a.file_name)
        .bind(&a.file_type)
        .bind(a.file_size)
        .bind(&a.date_taken)
        .bind(&a.camera_make)
        .bind(&a.camera_model)
        .bind(&a.lens_model)
        .bind(a.iso)
        .bind(a.f_number)
        .bind(&a.shutter_speed)
        .bind(a.focal_length)
        .bind(a.width)
        .bind(a.height)
        .bind(a.is_raw as i64)
        .execute(&mut *tx)
        .await?;
        if res.rows_affected() > 0 {
            inserted += 1;
        }
    }
    tx.commit().await?;
    Ok(inserted)
}

#[derive(Debug, Serialize)]
pub struct ListAssetsResult {
    pub items: Vec<Asset>,
    pub total: i64,
}

/// 按 [`AssetQuery`] 动态拼 SQL 查询资产列表。
///
/// 之所以手动拼 SQL 而不是用 `sqlx::query!` 宏：
/// - 条件字段是可选的，宏式参数无法表达"此字段不存在则跳过"；
/// - 排序字段是枚举常量集合，列名直接拼接安全。
///
/// 用户输入只通过 `?` 占位符 + `bind` 进入语句，不会拼接到 SQL 文本里，
/// 所以即使 `search` 含 `'` 或 `;` 也不会造成 SQL 注入。
pub async fn list(pool: &SqlitePool, q: &AssetQuery) -> Result<ListAssetsResult> {
    let mut sql = String::from("SELECT a.* FROM assets a");
    let mut where_clauses: Vec<String> = Vec::new();
    let mut binds: Vec<Bind> = Vec::new();

    if let Some(project_id) = q.project_id {
        sql.push_str(" INNER JOIN project_assets aa ON aa.asset_id = a.id");
        where_clauses.push("aa.project_id = ?".into());
        binds.push(Bind::I64(project_id));
    }
    if let Some(cm) = &q.camera_model {
        where_clauses.push("a.camera_model = ?".into());
        binds.push(Bind::Str(cm.clone()));
    }
    if let Some(lm) = &q.lens_model {
        where_clauses.push("a.lens_model = ?".into());
        binds.push(Bind::Str(lm.clone()));
    }
    if let Some(mr) = q.min_rating {
        where_clauses.push("a.star_rating >= ?".into());
        binds.push(Bind::I64(mr));
    }
    if let Some(cl) = &q.color_label {
        where_clauses.push("a.color_label = ?".into());
        binds.push(Bind::Str(cl.clone()));
    }
    if let Some(min_iso) = q.min_iso {
        where_clauses.push("a.iso >= ?".into());
        binds.push(Bind::I64(min_iso));
    }
    if let Some(max_iso) = q.max_iso {
        where_clauses.push("a.iso <= ?".into());
        binds.push(Bind::I64(max_iso));
    }
    if let Some(s) = &q.search {
        where_clauses
            .push("(a.file_name LIKE ? OR a.camera_model LIKE ? OR a.lens_model LIKE ?)".into());
        let pat = format!("%{}%", s);
        binds.push(Bind::Str(pat.clone()));
        binds.push(Bind::Str(pat.clone()));
        binds.push(Bind::Str(pat));
    }

    if !where_clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_clauses.join(" AND "));
    }

    let sort_col = match q.sort_by {
        SortBy::DateTaken => "a.date_taken",
        SortBy::FileName => "a.file_name",
        SortBy::CameraModel => "a.camera_model",
        SortBy::LensModel => "a.lens_model",
        SortBy::Iso => "a.iso",
        SortBy::StarRating => "a.star_rating",
        SortBy::CreatedAt => "a.created_at",
    };
    let sort_dir = match q.sort_dir {
        SortDir::Asc => "ASC",
        SortDir::Desc => "DESC",
    };
    // count query：从已构建的 sql 派生，截取 FROM 之后的部分（含 JOIN + WHERE）
    // 此时 sql = "SELECT a.* FROM assets a [JOIN] [WHERE]"，ORDER BY 尚未追加
    let from_pos = sql.find(" FROM ").expect("sql always contains FROM");
    let count_sql = format!("SELECT COUNT(*){}", &sql[from_pos..]);
    let mut count_query = sqlx::query_as::<_, (i64,)>(&count_sql);

    sql.push_str(&format!(" ORDER BY {} {} NULLS LAST", sort_col, sort_dir));
    for b in &binds {
        count_query = match b {
            Bind::I64(v) => count_query.bind(*v),
            Bind::Str(v) => count_query.bind(v.clone()),
        };
    }
    let (total,) = count_query.fetch_one(pool).await?;

    let limit = q.limit.unwrap_or(500);
    let offset = q.offset.unwrap_or(0);
    sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

    let mut items_query = sqlx::query_as::<_, Asset>(&sql);
    for b in binds {
        items_query = match b {
            Bind::I64(v) => items_query.bind(v),
            Bind::Str(v) => items_query.bind(v),
        };
    }
    let items = items_query.fetch_all(pool).await?;
    Ok(ListAssetsResult { items, total })
}

/// 一个 trait object 替身，把 i64/字符串两种 bind 值塞进同一个 `Vec`。
/// 用 enum 而不是 `Box<dyn>` 是因为 sqlx 的 bind 链 API 不接受 dyn 对象。
enum Bind {
    I64(i64),
    Str(String),
}

/// 单条查询。资产不存在时返回 `AppError::NotFound`，便于 IPC 层向前端返回 404 语义。
pub async fn get(pool: &SqlitePool, id: i64) -> Result<Asset> {
    sqlx::query_as::<_, Asset>("SELECT * FROM assets WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("asset {id}")))
}

pub async fn get_many(pool: &SqlitePool, ids: &[i64]) -> Result<Vec<Asset>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(500) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT * FROM assets WHERE id IN ({placeholders})");
        let mut q = sqlx::query_as::<_, Asset>(&sql);
        for id in chunk {
            q = q.bind(id);
        }
        out.extend(q.fetch_all(pool).await?);
    }
    Ok(out)
}

/// 查询回收站中某个相册永久清除时会变成孤儿的资产。
///
/// 必须在 `projects::purge` 删除记录前调用，供 IPC 层清理磁盘缓存使用。
pub async fn orphaned_for_trashed_project(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<Vec<Asset>> {
    sqlx::query_as::<_, Asset>(
        r#"
        SELECT a.* FROM assets a
        INNER JOIN project_assets aa ON aa.asset_id = a.id
        WHERE aa.project_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM project_assets aa2
            WHERE aa2.asset_id = aa.asset_id AND aa2.project_id <> ?
          )
        "#,
    )
    .bind(project_id)
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/// 查询清空回收站时会被删除的资产。
///
/// 仍属于未删除相册的资产不会返回，保持和 `projects::purge_all` 一致。
pub async fn orphaned_for_all_trashed_projects(pool: &SqlitePool) -> Result<Vec<Asset>> {
    sqlx::query_as::<_, Asset>(
        r#"
        SELECT DISTINCT a.* FROM assets a
        INNER JOIN project_assets aa ON aa.asset_id = a.id
        INNER JOIN projects p ON p.id = aa.project_id
        WHERE p.is_deleted = 1
          AND NOT EXISTS (
            SELECT 1 FROM project_assets aa2
            INNER JOIN projects p2 ON p2.id = aa2.project_id
            WHERE aa2.asset_id = aa.asset_id AND p2.is_deleted = 0
          )
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn list_for_project(pool: &SqlitePool, project_id: i64) -> Result<Vec<Asset>> {
    sqlx::query_as::<_, Asset>(
        "SELECT a.* FROM assets a \
         INNER JOIN project_assets aa ON aa.asset_id = a.id \
         WHERE aa.project_id = ?",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn update_rating(pool: &SqlitePool, id: i64, rating: i64) -> Result<()> {
    sqlx::query("UPDATE assets SET star_rating = ? WHERE id = ?")
        .bind(rating)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_color_label(pool: &SqlitePool, id: i64, label: Option<&str>) -> Result<()> {
    sqlx::query("UPDATE assets SET color_label = ? WHERE id = ?")
        .bind(label)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_path(pool: &SqlitePool, id: i64, new_path: &str, new_name: &str) -> Result<()> {
    sqlx::query("UPDATE assets SET file_path = ?, file_name = ? WHERE id = ?")
        .bind(new_path)
        .bind(new_name)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM assets WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 根据物理路径批量查 id。
///
/// 用于导入完成后把刚入库 + 已存在的资产一起挂到目标相册——
/// 仅靠 `insert_many` 返回的 inserted 数量不够，那只是"新插入"的计数。
/// 路径列表长度通常 ≤ 单次扫描结果（几百到几千），分批 IN 查询足以。
pub async fn id_by_path(pool: &SqlitePool, path: &str) -> Result<Option<i64>> {
    let row = sqlx::query_as::<_, (i64,)>("SELECT id FROM assets WHERE file_path = ?")
        .bind(path)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(id,)| id))
}

pub async fn ids_by_paths(pool: &SqlitePool, paths: &[String]) -> Result<Vec<i64>> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(paths.len());
    // SQLite 默认 host 参数上限是 999，留点余量分批
    for chunk in paths.chunks(500) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT id FROM assets WHERE file_path IN ({placeholders})");
        let mut q = sqlx::query_as::<_, (i64,)>(&sql);
        for p in chunk {
            q = q.bind(p);
        }
        let rows = q.fetch_all(pool).await?;
        out.extend(rows.into_iter().map(|(id,)| id));
    }
    Ok(out)
}

pub async fn distinct_cameras(pool: &SqlitePool) -> Result<Vec<String>> {
    let rows: Vec<(Option<String>,)> = sqlx::query_as(
        "SELECT DISTINCT camera_model FROM assets WHERE camera_model IS NOT NULL ORDER BY camera_model",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().filter_map(|(x,)| x).collect())
}

pub async fn distinct_lenses(pool: &SqlitePool) -> Result<Vec<String>> {
    let rows: Vec<(Option<String>,)> = sqlx::query_as(
        "SELECT DISTINCT lens_model FROM assets WHERE lens_model IS NOT NULL ORDER BY lens_model",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().filter_map(|(x,)| x).collect())
}

/// 全量统计：用于侧边栏/Dashboard 显示"共 N 张"。
#[derive(Debug, Serialize)]
pub struct LibraryStats {
    pub total: i64,
    pub by_camera: Vec<(String, i64)>,
}

pub async fn all_raw_ids(pool: &SqlitePool) -> Result<Vec<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as("SELECT id FROM assets WHERE is_raw = 1")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

pub async fn stats(pool: &SqlitePool) -> Result<LibraryStats> {
    let (total,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM assets")
        .fetch_one(pool)
        .await?;
    let by_camera: Vec<(String, i64)> = sqlx::query_as(
        "SELECT camera_model, COUNT(*) FROM assets WHERE camera_model IS NOT NULL GROUP BY camera_model ORDER BY 2 DESC LIMIT 20",
    )
    .fetch_all(pool)
    .await?;
    Ok(LibraryStats { total, by_camera })
}

/// 取出 exif_extracted=0 的资产，最多 limit 条
pub async fn list_exif_pending(pool: &SqlitePool, limit: i64) -> Result<Vec<Asset>> {
    Ok(
        sqlx::query_as::<_, Asset>("SELECT * FROM assets WHERE exif_extracted = 0 LIMIT ?")
            .bind(limit)
            .fetch_all(pool)
            .await?,
    )
}

/// 把 EXIF 数据写回资产，标记 exif_extracted=1
pub async fn update_exif(
    pool: &SqlitePool,
    id: i64,
    exif: &crate::asset::exif::ExifData,
    width: Option<i64>,
    height: Option<i64>,
) -> Result<()> {
    sqlx::query(
        "UPDATE assets SET
           date_taken=?, camera_make=?, camera_model=?, lens_model=?,
           iso=?, f_number=?, shutter_speed=?, focal_length=?,
           width=?, height=?, exif_extracted=1
         WHERE id=?",
    )
    .bind(&exif.date_taken)
    .bind(&exif.camera_make)
    .bind(&exif.camera_model)
    .bind(&exif.lens_model)
    .bind(exif.iso)
    .bind(exif.f_number)
    .bind(&exif.shutter_speed)
    .bind(exif.focal_length)
    .bind(width)
    .bind(height)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

#[allow(dead_code)]
pub fn _placeholder_time() -> DateTime<Utc> {
    Utc::now()
}

pub async fn update_cover_path(pool: &SqlitePool, id: i64, cover_path: &str) -> Result<()> {
    sqlx::query("UPDATE assets SET cover_path = ? WHERE id = ?")
        .bind(cover_path)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

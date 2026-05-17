use crate::error::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

/// 滤镜预设的读模型。
///
/// `is_builtin=1` 的预设是 13 个内置富士模拟（启动时种子写入），
/// 它们的删除会被 [`delete`] 函数拒绝（SQL WHERE 内带 `is_builtin = 0`）。
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct FilterPreset {
    pub id: i64,
    pub name: String,
    pub base_simulation: String,
    pub grain_effect: Option<String>,
    pub grain_size: Option<String>,
    pub color_chrome_effect: Option<String>,
    pub highlight_tone: f64,
    pub shadow_tone: f64,
    pub color_saturation: f64,
    pub clarity: f64,
    pub sharpness: f64,
    pub wb_shift_r: i64,
    pub wb_shift_b: i64,
    pub lut_file_path: Option<String>,
    pub is_builtin: i64,
    pub created_at: String,
}

/// 写模型：用 `bool` 表达 `is_builtin`，比 `i64` 直观。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewFilterPreset {
    pub name: String,
    pub base_simulation: String,
    pub grain_effect: Option<String>,
    pub grain_size: Option<String>,
    pub color_chrome_effect: Option<String>,
    pub highlight_tone: f64,
    pub shadow_tone: f64,
    pub color_saturation: f64,
    pub clarity: f64,
    pub sharpness: f64,
    pub wb_shift_r: i64,
    pub wb_shift_b: i64,
    pub lut_file_path: Option<String>,
    pub is_builtin: bool,
}

/// Upsert 一条预设：若名字已存在则更新所有字段，否则插入新行。
/// 这样应用启动种子内置预设和用户保存自定义预设可以走同一条路径。
pub async fn upsert(pool: &SqlitePool, p: &NewFilterPreset) -> Result<FilterPreset> {
    sqlx::query(
        r#"INSERT INTO filter_presets (name,base_simulation,grain_effect,grain_size,color_chrome_effect,highlight_tone,shadow_tone,color_saturation,clarity,sharpness,wb_shift_r,wb_shift_b,lut_file_path,is_builtin)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(name) DO UPDATE SET
             base_simulation=excluded.base_simulation,
             grain_effect=excluded.grain_effect,
             grain_size=excluded.grain_size,
             color_chrome_effect=excluded.color_chrome_effect,
             highlight_tone=excluded.highlight_tone,
             shadow_tone=excluded.shadow_tone,
             color_saturation=excluded.color_saturation,
             clarity=excluded.clarity,
             sharpness=excluded.sharpness,
             wb_shift_r=excluded.wb_shift_r,
             wb_shift_b=excluded.wb_shift_b,
             lut_file_path=excluded.lut_file_path,
             is_builtin=excluded.is_builtin"#,
    )
    .bind(&p.name)
    .bind(&p.base_simulation)
    .bind(&p.grain_effect)
    .bind(&p.grain_size)
    .bind(&p.color_chrome_effect)
    .bind(p.highlight_tone)
    .bind(p.shadow_tone)
    .bind(p.color_saturation)
    .bind(p.clarity)
    .bind(p.sharpness)
    .bind(p.wb_shift_r)
    .bind(p.wb_shift_b)
    .bind(&p.lut_file_path)
    .bind(p.is_builtin as i64)
    .execute(pool)
    .await?;
    sqlx::query_as::<_, FilterPreset>("SELECT * FROM filter_presets WHERE name = ?")
        .bind(&p.name)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<FilterPreset>> {
    sqlx::query_as::<_, FilterPreset>(
        "SELECT * FROM filter_presets ORDER BY is_builtin DESC, name ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/// 删除预设。**仅允许删自定义预设**：SQL WHERE 强制 `is_builtin = 0`，
/// 即使前端误传内置预设 id 也无法误删，UI 端也做了一道防护。
pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM filter_presets WHERE id = ? AND is_builtin = 0")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

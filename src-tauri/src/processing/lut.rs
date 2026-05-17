use crate::error::{AppError, Result};
use std::fs;
use std::path::Path;

/// 3D 颜色查找表（LUT）。
///
/// `.cube` 文件描述了"输入 RGB → 输出 RGB"的稀疏采样网格，
/// 例如 33×33×33 = 35937 个采样点，每个点存 3 个浮点。
/// 应用时用三线性插值（trilinear）在这个网格里查色。
pub struct Lut3D {
    /// 网格边长（17 / 33 / 64 等常见尺寸）。
    pub size: usize,
    /// 扁平存放的 RGB 三元组，长度 = `size^3 * 3`。
    /// 索引规则：`(b * size * size + g * size + r) * 3` —— 蓝通道做最外层循环（cube 文件惯例）。
    pub data: Vec<f32>,
}

impl Lut3D {
    /// 解析 Adobe `.cube` 格式 LUT 文件。
    ///
    /// 容忍少量格式细节：跳过空行、`#` 注释、`TITLE`、`DOMAIN_*` 等元信息行。
    /// 只关心 `LUT_3D_SIZE` 与后续的 N×N×N 个 RGB 行。
    pub fn load_cube(path: &Path) -> Result<Self> {
        let text = fs::read_to_string(path)?;
        let mut size = 0usize;
        let mut data: Vec<f32> = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(rest) = line.strip_prefix("LUT_3D_SIZE") {
                size = rest.trim().parse::<usize>().map_err(|e| AppError::other(e.to_string()))?;
                continue;
            }
            if line.starts_with("TITLE") || line.starts_with("DOMAIN_") {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() == 3 {
                for p in parts {
                    data.push(p.parse::<f32>().map_err(|e| AppError::other(e.to_string()))?);
                }
            }
        }
        if size == 0 || data.len() != size * size * size * 3 {
            return Err(AppError::other(format!(
                "invalid .cube file (size={size}, samples={})",
                data.len() / 3
            )));
        }
        Ok(Lut3D { size, data })
    }

    /// 在 LUT 上做三线性插值，把单个像素 (r,g,b) ∈ [0,1]³ 映射为输出 (r',g',b')。
    ///
    /// 算法：找到输入点落入的 1×1×1 小立方体的 8 个顶点，先沿 R 轴线性插值得 4 条边，
    /// 再沿 G 轴插值得 2 条线，最后沿 B 轴插值得 1 个点。
    #[inline]
    pub fn apply(&self, r: f32, g: f32, b: f32) -> (f32, f32, f32) {
        let n = (self.size - 1) as f32;
        let rs = r.clamp(0.0, 1.0) * n;
        let gs = g.clamp(0.0, 1.0) * n;
        let bs = b.clamp(0.0, 1.0) * n;
        let r0 = rs.floor() as usize;
        let g0 = gs.floor() as usize;
        let b0 = bs.floor() as usize;
        let r1 = (r0 + 1).min(self.size - 1);
        let g1 = (g0 + 1).min(self.size - 1);
        let b1 = (b0 + 1).min(self.size - 1);
        let fr = rs - r0 as f32;
        let fg = gs - g0 as f32;
        let fb = bs - b0 as f32;
        // 计算 8 个角点的 base 偏移（直接对应 data 数组里 RGB 三元组的起点）
        let idx = |r: usize, g: usize, b: usize| (b * self.size * self.size + g * self.size + r) * 3;
        let c000 = idx(r0, g0, b0);
        let c100 = idx(r1, g0, b0);
        let c010 = idx(r0, g1, b0);
        let c110 = idx(r1, g1, b0);
        let c001 = idx(r0, g0, b1);
        let c101 = idx(r1, g0, b1);
        let c011 = idx(r0, g1, b1);
        let c111 = idx(r1, g1, b1);
        let mut out = [0f32; 3];
        // R/G/B 三个通道分别走一次三线性插值
        for (k, slot) in out.iter_mut().enumerate() {
            let c00 = self.data[c000 + k] * (1.0 - fr) + self.data[c100 + k] * fr;
            let c01 = self.data[c001 + k] * (1.0 - fr) + self.data[c101 + k] * fr;
            let c10 = self.data[c010 + k] * (1.0 - fr) + self.data[c110 + k] * fr;
            let c11 = self.data[c011 + k] * (1.0 - fr) + self.data[c111 + k] * fr;
            let c0 = c00 * (1.0 - fg) + c10 * fg;
            let c1 = c01 * (1.0 - fg) + c11 * fg;
            *slot = c0 * (1.0 - fb) + c1 * fb;
        }
        (out[0], out[1], out[2])
    }
}

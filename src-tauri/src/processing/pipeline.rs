use crate::error::Result;
use crate::processing::{
    color::{self, f_to_u16, u16_to_f},
    curves::{self, ToneCurve},
    fuji,
    grain::{self, GrainSize, GrainStrength},
    lut::Lut3D,
};
use image::{ImageBuffer, Rgb};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 一组完整的色彩参数，等同于"用户当前在 UI 上看到的滤镜设置"。
///
/// 字段命名与前端 [`FilterSettings`](../../../src/types.ts) 保持一致，
/// 通过 serde 自动收/发；缺省值由 `Default` 与 `#[serde(default)]` 给出，
/// 保证前端发送部分字段也能正常工作。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterSettings {
    pub base_simulation: String,
    #[serde(default)]
    pub grain_effect: Option<String>,
    #[serde(default)]
    pub grain_size: Option<String>,
    #[serde(default)]
    pub color_chrome_effect: Option<String>,
    #[serde(default)]
    pub highlight_tone: f32,
    #[serde(default)]
    pub shadow_tone: f32,
    #[serde(default)]
    pub color_saturation: f32,
    #[serde(default)]
    pub clarity: f32,
    #[serde(default)]
    pub sharpness: f32,
    #[serde(default)]
    pub wb_shift_r: i32,
    #[serde(default)]
    pub wb_shift_b: i32,
    #[serde(default)]
    pub lut_file_path: Option<PathBuf>,
}

impl Default for FilterSettings {
    fn default() -> Self {
        Self {
            base_simulation: "Provia".into(),
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
        }
    }
}

/// **核心色彩流水线**。输入 16-bit RGB 图，输出 16-bit RGB 图。
///
/// 步骤顺序：
/// 1. **白平衡偏移**（WB Shift R/B）—— 在线性空间整体偏色；
/// 2. **分通道色调曲线** —— 实现对比度 + 高光/阴影 + 富士预设的色彩偏好；
/// 3. **Split Toning** —— 高光/阴影分别染色，模拟胶片的"暖高光冷阴影"；
/// 4. **饱和度** —— 预设值 + 用户增量；
/// 5. **Color Chrome** —— 高饱和区进一步加饱和（富士机内同名功能）；
/// 6. **褪色** —— 给整图加一层灰底，模拟 Eterna / Classic Neg 的低对比感；
/// 7. **黑白转换** —— 对 Acros / Monochrome 预设生效；
/// 8. **3D LUT** —— 用户外挂 .cube（由调用方预先加载并传入，避免重复 IO）；
/// 9. **Clarity / Sharpness** —— 基于亮度局部模糊的非锐化遮罩；
/// 10. **胶片颗粒** —— 最后合成，与亮度做掩膜（中灰最重）。
///
/// 像素遍历使用 [`rayon::par_chunks_mut`] 并行，每个像素独立计算可线性扩展到多核。
///
/// `lut` 由调用方传入（可为 `None`），避免每次调用都从磁盘重新加载。
pub fn process_image(
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    settings: &FilterSettings,
    lut: Option<&Lut3D>,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    let (w, h) = src.dimensions();
    let profile = fuji::lookup(&settings.base_simulation);

    // 用户的高光/阴影/对比叠加在预设上（预设的 contrast 直接进 curve.build 的第三个参数）
    let curve = ToneCurve::build(
        settings.highlight_tone + profile.contrast * 0.0,
        settings.shadow_tone,
        profile.contrast,
    );
    // 三条分通道曲线，本质上是"基础曲线复合一次轻微弯折"
    let (rc, gc, bc) =
        curves::build_per_channel_curves(&curve, profile.r_tilt, profile.g_tilt, profile.b_tilt);

    // Color Chrome 在 HSL 空间根据现有饱和度做"再升一档"
    let chrome_strength = match settings.color_chrome_effect.as_deref().unwrap_or("None") {
        "Weak" => 0.15,
        "Strong" => 0.30,
        _ => 0.0,
    };

    // 主缓冲区：连续 RGB 浮点，便于 par_chunks_mut(3) 一次处理一个像素
    let mut buf: Vec<f32> = vec![0.0; (w * h * 3) as usize];

    buf.par_chunks_mut(3)
        .enumerate()
        .for_each(|(idx, chunk)| {
            // 从原图取出 16-bit 像素并归一化到 [0,1]
            let px = src.get_pixel((idx as u32) % w, (idx as u32) / w);
            let mut r = u16_to_f(px.0[0]);
            let mut g = u16_to_f(px.0[1]);
            let mut b = u16_to_f(px.0[2]);

            // [1] 白平衡偏移：富士机内是 -9..+9 整数档，每档对应 ~2% 的通道增益
            let (nr, ng, nb) = color::apply_wb_shift(r, g, b, settings.wb_shift_r, settings.wb_shift_b);
            r = nr; g = ng; b = nb;

            // [2] 分通道色调曲线
            r = rc.apply(r);
            g = gc.apply(g);
            b = bc.apply(b);

            // [3] Split Toning：根据亮度把像素分到"高光端"或"阴影端"，分别乘以预设里的染色系数
            let l = color::luminance(r, g, b);
            let hi = (l - 0.5).max(0.0) * 2.0;
            let sh = (0.5 - l).max(0.0) * 2.0;
            r *= color::channel_lerp(1.0, profile.split_highlight.0, hi);
            g *= color::channel_lerp(1.0, profile.split_highlight.1, hi);
            b *= color::channel_lerp(1.0, profile.split_highlight.2, hi);
            r *= color::channel_lerp(1.0, profile.split_shadow.0, sh);
            g *= color::channel_lerp(1.0, profile.split_shadow.1, sh);
            b *= color::channel_lerp(1.0, profile.split_shadow.2, sh);

            // 整体微调三通道（预设里独立配置，Velvia 红/绿都正向、Classic Chrome 红负蓝正等等）
            r += profile.red_shift * 0.05;
            g += profile.green_shift * 0.05;
            b += profile.blue_shift * 0.05;

            // [4] 饱和度：以亮度为锚点的线性插值，避免单纯乘法导致颜色偏移
            let sat_amount = profile.saturation + settings.color_saturation;
            let (sr, sg, sb) = color::saturate(r, g, b, sat_amount);
            r = sr; g = sg; b = sb;

            // [5] Color Chrome：在 HSL 空间提升已经较饱和的区域
            if chrome_strength > 0.0 {
                let (h_, s, lv) = color::rgb_to_hsl(r, g, b);
                let boosted_s = (s + chrome_strength * (1.0 - s) * 0.5).clamp(0.0, 1.0);
                let (cr, cg, cb) = color::hsl_to_rgb(h_, boosted_s, lv);
                r = cr; g = cg; b = cb;
            }

            // [6] 褪色：往全图掺一点点亮灰（蓝偏一点点），实现"奶油色调"
            if profile.fade > 0.0 {
                let f = profile.fade;
                r = r * (1.0 - f) + 0.08 * f;
                g = g * (1.0 - f) + 0.08 * f;
                b = b * (1.0 - f) + 0.10 * f;
            }

            // [7] 黑白：用 Rec.601 亮度转灰度，再乘以预设的染色系数实现黄/红滤片效果
            if profile.monochrome {
                let y = 0.299 * r + 0.587 * g + 0.114 * b;
                r = (y * profile.mono_tint.0).clamp(0.0, 1.0);
                g = (y * profile.mono_tint.1).clamp(0.0, 1.0);
                b = (y * profile.mono_tint.2).clamp(0.0, 1.0);
            }

            // [8] 外挂 3D LUT：放在最后，让用户的 LUT 工作在已应用富士曲线后的色彩上
            if let Some(lut) = &lut {
                let (lr, lg, lb) = lut.apply(r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0));
                r = lr; g = lg; b = lb;
            }

            chunk[0] = r.clamp(0.0, 1.0);
            chunk[1] = g.clamp(0.0, 1.0);
            chunk[2] = b.clamp(0.0, 1.0);
        });

    // [9] Clarity / Sharpness：基于亮度的非锐化遮罩。半径不同：Clarity 模拟"中频对比"，Sharpness 是细节锐化
    if settings.clarity.abs() > 0.001 {
        apply_clarity(&mut buf, w, h, settings.clarity);
    }
    if settings.sharpness.abs() > 0.001 {
        apply_unsharp(&mut buf, w, h, settings.sharpness);
    }

    // [10] 颗粒：最后做，保证颗粒不会被锐化算法当作"细节"二次放大
    let strength = GrainStrength::parse(settings.grain_effect.as_deref());
    let size = GrainSize::parse(settings.grain_size.as_deref());
    grain::apply_grain(&mut buf, w, h, strength, size, 0xC0FFEEu64);

    // 浮点缓冲区写回 16-bit RGB（按行并行）
    let mut out: ImageBuffer<Rgb<u16>, Vec<u16>> = ImageBuffer::new(w, h);
    out.rows_mut()
        .enumerate()
        .par_bridge()
        .for_each(|(y, row)| {
            for (x, px) in row.enumerate() {
                let i = ((y as u32 * w + x as u32) * 3) as usize;
                *px = Rgb([f_to_u16(buf[i]), f_to_u16(buf[i + 1]), f_to_u16(buf[i + 2])]);
            }
        });
    Ok(out)
}

/// "清晰度"（Clarity）：用半径 8 的大尺度模糊作为"低频参考"，
/// 把每像素亮度与之做差再叠回原图，实现"中频对比增强"。
/// 正值让图像更"通透"，负值产生柔焦效果。
fn apply_clarity(buf: &mut [f32], w: u32, h: u32, amount: f32) {
    let blurred = box_blur_lum(buf, w, h, 8);
    for (i, lum) in blurred.iter().enumerate() {
        let base = i * 3;
        let l = 0.2126 * buf[base] + 0.7152 * buf[base + 1] + 0.0722 * buf[base + 2];
        let delta = (l - lum) * amount;
        buf[base] = (buf[base] + delta).clamp(0.0, 1.0);
        buf[base + 1] = (buf[base + 1] + delta).clamp(0.0, 1.0);
        buf[base + 2] = (buf[base + 2] + delta).clamp(0.0, 1.0);
    }
}

/// "锐度"（Sharpness）：与 Clarity 同种数学，但用半径 2 的小模糊，
/// 放大像素级细节而不是整体对比。系数 ×1.5 是经验放大值。
fn apply_unsharp(buf: &mut [f32], w: u32, h: u32, amount: f32) {
    let blurred = box_blur_lum(buf, w, h, 2);
    for (i, lum) in blurred.iter().enumerate() {
        let base = i * 3;
        let l = 0.2126 * buf[base] + 0.7152 * buf[base + 1] + 0.0722 * buf[base + 2];
        let delta = (l - lum) * amount * 1.5;
        buf[base] = (buf[base] + delta).clamp(0.0, 1.0);
        buf[base + 1] = (buf[base + 1] + delta).clamp(0.0, 1.0);
        buf[base + 2] = (buf[base + 2] + delta).clamp(0.0, 1.0);
    }
}

/// 对 RGB 缓冲区先抽取亮度通道，再做两遍可分离的盒式模糊（先横向、再纵向）。
/// 比一次 2D 卷积快得多，对 Clarity/Sharpness 的视觉效果足够好。
///
/// 优化：横向 pass 在计算时直接内联亮度提取，省去独立的 lum 缓冲区（节省 w×h×4B）；
/// 两个 pass 均通过 rayon 按行并行，充分利用多核。
fn box_blur_lum(buf: &[f32], w: u32, h: u32, radius: i32) -> Vec<f32> {
    let len = (w * h) as usize;
    let w_i = w as i32;
    let h_i = h as i32;

    // 横向 pass：内联亮度提取 + 按行并行
    let mut tmp = vec![0f32; len];
    tmp.par_chunks_mut(w as usize)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..w_i {
                let mut sum = 0.0f32;
                let mut count = 0.0f32;
                for dx in -radius..=radius {
                    let nx = x + dx;
                    if nx >= 0 && nx < w_i {
                        let base = (y as i32 * w_i + nx) as usize * 3;
                        sum += 0.2126 * buf[base] + 0.7152 * buf[base + 1] + 0.0722 * buf[base + 2];
                        count += 1.0;
                    }
                }
                row[x as usize] = sum / count;
            }
        });

    // 纵向 pass：按行并行（每行读取 tmp 的多行，tmp 已完全写入，无数据竞争）
    let mut out = vec![0f32; len];
    out.par_chunks_mut(w as usize)
        .enumerate()
        .for_each(|(y, row)| {
            let y = y as i32;
            for x in 0..w_i {
                let mut sum = 0.0f32;
                let mut count = 0.0f32;
                for dy in -radius..=radius {
                    let ny = y + dy;
                    if ny >= 0 && ny < h_i {
                        sum += tmp[(ny * w_i + x) as usize];
                        count += 1.0;
                    }
                }
                row[x as usize] = sum / count;
            }
        });
    out
}

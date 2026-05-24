use crate::error::Result;
use crate::processing::dehaze::apply_dehaze;
use crate::processing::saturation::{apply_saturation_pixel, apply_vibrance_pixel};
use crate::processing::tone::{
    apply_brightness_pixel, apply_contrast_pixel, apply_exposure_pixel, apply_tone_segments_pixel,
};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurvePoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ToneCurvePoints {
    pub rgb: Vec<CurvePoint>,
    pub r: Vec<CurvePoint>,
    pub g: Vec<CurvePoint>,
    pub b: Vec<CurvePoint>,
}

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
    pub exposure: f32,
    #[serde(default)]
    pub contrast: i32,
    #[serde(default)]
    pub brightness: i32,
    #[serde(default)]
    pub highlight_tone: i32,
    #[serde(default)]
    pub shadow_tone: i32,
    #[serde(default)]
    pub white: i32,
    #[serde(default)]
    pub black: i32,
    #[serde(default)]
    pub dehaze: i32,
    #[serde(default)]
    pub vibrance: i32,
    #[serde(default)]
    pub color_saturation: i32,
    #[serde(default)]
    pub clarity: i32,
    #[serde(default)]
    pub sharpness: i32,
    #[serde(default)]
    pub wb_shift_r: i32,
    #[serde(default)]
    pub wb_shift_b: i32,
    #[serde(default)]
    pub tone_curve: Option<ToneCurvePoints>,
    #[serde(default)]
    pub lut_file_path: Option<PathBuf>,
}

impl FilterSettings {
    pub fn is_identity(&self) -> bool {
        (self.base_simulation == "Pass-Through" || self.base_simulation.is_empty())
            && self.lut_file_path.is_none()
            && self.exposure == 0.0
            && self.contrast == 0
            && self.brightness == 0
            && self.highlight_tone == 0
            && self.shadow_tone == 0
            && self.white == 0
            && self.black == 0
            && self.dehaze == 0
            && self.vibrance == 0
            && self.color_saturation == 0
            && self.clarity == 0
            && self.sharpness == 0
            && self.wb_shift_r == 0
            && self.wb_shift_b == 0
            && matches!(self.grain_effect.as_deref(), None | Some("None"))
            && matches!(self.color_chrome_effect.as_deref(), None | Some("None"))
            && self.tone_curve.as_ref().map_or(true, |tc| {
                tc.rgb.is_empty() && tc.r.is_empty() && tc.g.is_empty() && tc.b.is_empty()
            })
    }
}

impl Default for FilterSettings {
    fn default() -> Self {
        Self {
            base_simulation: "Pass-Through".into(),
            grain_effect: None,
            grain_size: None,
            color_chrome_effect: None,
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
            tone_curve: None,
            lut_file_path: None,
        }
    }
}

/// **核心色彩流水线**。输入 16-bit RGB 图，输出 16-bit RGB 图。
///
/// 步骤顺序（与下方像素循环里的 `[N]` 注释一一对应）：
/// 1.  **白平衡偏移**（WB Shift R/B）—— 在线性空间整体偏色；
/// 2.  **曝光**（Exposure）—— 线性增益，2^EV；
/// 3.  **明亮度 + 对比度**（Brightness / Contrast）—— 在分段曲线之前先把整体亮度/对比拉到位；
/// 4.  **四段色调**（Highlight / Shadow / White / Black）—— 高光、阴影、白阶、黑阶分段调整；
/// 5.  **分通道色调曲线**（Fuji 预设）+ 用户自定义点曲线 —— 实现富士的色彩偏好；
/// 6.  **Split Toning** —— 高光/阴影分别染色，模拟胶片的"暖高光冷阴影"；
/// 7.  **Vibrance + Saturation**（含预设饱和度）—— 低饱和优先 + 全局饱和度叠加；
/// 8.  **Color Chrome** —— 高饱和区进一步加饱和（富士机内同名功能）；
/// 9.  **褪色** —— 给整图加一层灰底，模拟 Eterna / Classic Neg 的低对比感；
/// 10. **黑白转换** —— 对 Acros / Monochrome 预设生效；
/// 11. **3D LUT** —— 用户外挂 .cube（由调用方预先加载并传入，避免重复 IO）；
/// 12. **Dehaze** —— 暗通道先验 + Guided Filter 全图操作；
/// 13. **Clarity / Sharpness** —— 基于亮度局部模糊的非锐化遮罩；
/// 14. **胶片颗粒** —— 最后合成，与亮度做掩膜（中灰最重）。
///
/// 像素遍历使用 [`rayon::par_chunks_mut`] 并行，每个像素独立计算可线性扩展到多核。
///
/// `lut` 由调用方传入（可为 `None`），避免每次调用都从磁盘重新加载。
pub fn process_image(
    src: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    settings: &FilterSettings,
    lut: Option<&Lut3D>,
) -> Result<ImageBuffer<Rgb<u16>, Vec<u16>>> {
    // 全默认 + 无 LUT 时直接返回原图，避免 decode→float→u16 的量化误差
    if lut.is_none() && settings.is_identity() {
        return Ok(src.clone());
    }

    let (w, h) = src.dimensions();
    let profile = fuji::lookup(&settings.base_simulation);

    // Fuji preset's contrast curve. User's highlight_tone/shadow_tone are now applied
    // separately via apply_tone_segments_pixel; pass 0 here so the preset curve isn't
    // double-counted.
    let curve = ToneCurve::build(0.0, 0.0, profile.contrast);
    // 三条分通道曲线，本质上是"基础曲线复合一次轻微弯折"
    let (rc, gc, bc) =
        curves::build_per_channel_curves(&curve, profile.r_tilt, profile.g_tilt, profile.b_tilt);

    // Pre-build user curve LUTs (once, before pixel loop)
    let user_rgb_curve = settings
        .tone_curve
        .as_ref()
        .filter(|tc| !tc.rgb.is_empty())
        .map(|tc| ToneCurve::from_points(&tc.rgb));
    let user_r_curve = settings
        .tone_curve
        .as_ref()
        .filter(|tc| !tc.r.is_empty())
        .map(|tc| ToneCurve::from_points(&tc.r));
    let user_g_curve = settings
        .tone_curve
        .as_ref()
        .filter(|tc| !tc.g.is_empty())
        .map(|tc| ToneCurve::from_points(&tc.g));
    let user_b_curve = settings
        .tone_curve
        .as_ref()
        .filter(|tc| !tc.b.is_empty())
        .map(|tc| ToneCurve::from_points(&tc.b));

    // Color Chrome 在 HSL 空间根据现有饱和度做"再升一档"
    let chrome_strength = match settings.color_chrome_effect.as_deref().unwrap_or("None") {
        "Weak" => 0.15,
        "Strong" => 0.30,
        _ => 0.0,
    };

    // 主缓冲区：连续 RGB 浮点，便于 par_chunks_mut(3) 一次处理一个像素
    let mut buf: Vec<f32> = vec![0.0; (w * h * 3) as usize];

    buf.par_chunks_mut(3).enumerate().for_each(|(idx, chunk)| {
        // 从原图取出 16-bit 像素并归一化到 [0,1]
        let px = src.get_pixel((idx as u32) % w, (idx as u32) / w);
        let mut r = u16_to_f(px.0[0]);
        let mut g = u16_to_f(px.0[1]);
        let mut b = u16_to_f(px.0[2]);

        // [1] WB shift
        let (nr, ng, nb) = color::apply_wb_shift(r, g, b, settings.wb_shift_r, settings.wb_shift_b);
        r = nr;
        g = ng;
        b = nb;

        // [2] Exposure (linear gain)
        let (nr, ng, nb) = apply_exposure_pixel(r, g, b, settings.exposure);
        r = nr;
        g = ng;
        b = nb;

        // [3] Brightness then Contrast
        let (nr, ng, nb) = apply_brightness_pixel(r, g, b, settings.brightness);
        r = nr;
        g = ng;
        b = nb;
        let (nr, ng, nb) = apply_contrast_pixel(r, g, b, settings.contrast);
        r = nr;
        g = ng;
        b = nb;

        // [4] Highlight / Shadow / White / Black 4-segment
        let (nr, ng, nb) = apply_tone_segments_pixel(
            r,
            g,
            b,
            settings.highlight_tone,
            settings.shadow_tone,
            settings.white,
            settings.black,
        );
        r = nr;
        g = ng;
        b = nb;

        // [5] 分通道色调曲线 (Fuji preset)
        r = rc.apply(r);
        g = gc.apply(g);
        b = bc.apply(b);

        // [5b] User point curves (applied on top of Fuji preset curves)
        if let Some(ref uc) = user_rgb_curve {
            r = uc.apply(r);
            g = uc.apply(g);
            b = uc.apply(b);
        }
        if let Some(ref uc) = user_r_curve {
            r = uc.apply(r);
        }
        if let Some(ref uc) = user_g_curve {
            g = uc.apply(g);
        }
        if let Some(ref uc) = user_b_curve {
            b = uc.apply(b);
        }

        // [6] Split Toning：根据亮度把像素分到"高光端"或"阴影端"，分别乘以预设里的染色系数
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

        // [7] Vibrance (low-sat weighted)
        let (nr, ng, nb) = apply_vibrance_pixel(r, g, b, settings.vibrance);
        r = nr;
        g = ng;
        b = nb;

        // [7b] Saturation (global) + Fuji preset's saturation
        // preset.saturation 范围是 -1..+1，折算到 -100..+100，与用户值合并
        #[allow(clippy::cast_possible_truncation)]
        let combined_sat = settings.color_saturation + (profile.saturation * 100.0) as i32;
        if combined_sat != 0 {
            let (nr, ng, nb) = apply_saturation_pixel(r, g, b, combined_sat);
            r = nr;
            g = ng;
            b = nb;
        }

        // [8] Color Chrome：在 HSL 空间提升已经较饱和的区域
        if chrome_strength > 0.0 {
            let (h_, s, lv) = color::rgb_to_hsl(r, g, b);
            let boosted_s = (s + chrome_strength * (1.0 - s) * 0.5).clamp(0.0, 1.0);
            let (cr, cg, cb) = color::hsl_to_rgb(h_, boosted_s, lv);
            r = cr;
            g = cg;
            b = cb;
        }

        // [9] 褪色：往全图掺一点点亮灰（蓝偏一点点），实现"奶油色调"
        if profile.fade > 0.0 {
            let f = profile.fade;
            r = r * (1.0 - f) + 0.08 * f;
            g = g * (1.0 - f) + 0.08 * f;
            b = b * (1.0 - f) + 0.10 * f;
        }

        // [10] 黑白：用 Rec.601 亮度转灰度，再乘以预设的染色系数实现黄/红滤片效果
        if profile.monochrome {
            let y = 0.299 * r + 0.587 * g + 0.114 * b;
            r = (y * profile.mono_tint.0).clamp(0.0, 1.0);
            g = (y * profile.mono_tint.1).clamp(0.0, 1.0);
            b = (y * profile.mono_tint.2).clamp(0.0, 1.0);
        }

        // [11] 外挂 3D LUT：放在最后，让用户的 LUT 工作在已应用富士曲线后的色彩上
        if let Some(lut) = &lut {
            let (lr, lg, lb) = lut.apply(r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0));
            r = lr;
            g = lg;
            b = lb;
        }

        chunk[0] = r.clamp(0.0, 1.0);
        chunk[1] = g.clamp(0.0, 1.0);
        chunk[2] = b.clamp(0.0, 1.0);
    });

    // [12] Dehaze (whole-image, DCP + guided filter)
    if settings.dehaze != 0 {
        apply_dehaze(&mut buf, w, h, settings.dehaze);
    }

    // [13] Clarity / Sharpness：基于亮度的非锐化遮罩。半径不同：Clarity 模拟"中频对比"，Sharpness 是细节锐化
    // 以 1920px 为基准缩放半径，保证视觉效果与预览一致
    let res_scale = (w.max(h) as f32 / 1920.0).max(1.0);
    if settings.clarity != 0 {
        let radius = (8.0 * res_scale).round() as i32;
        apply_clarity(&mut buf, w, h, settings.clarity as f32 / 100.0, radius);
    }
    if settings.sharpness != 0 {
        let radius = (2.0 * res_scale).round() as i32;
        apply_unsharp(&mut buf, w, h, settings.sharpness as f32 / 100.0, radius);
    }

    // [14] 颗粒：最后做，保证颗粒不会被锐化算法当作"细节"二次放大
    let strength = GrainStrength::parse(settings.grain_effect.as_deref());
    let size = GrainSize::parse(settings.grain_size.as_deref());
    // 以 1920px 为基准缩放 cell，保证颗粒视觉大小与预览一致
    let base_cell = size.cell();
    let scale_factor = (w.max(h) as f32 / 1920.0).max(1.0).round() as u32;
    let scaled_size = grain::GrainSize::Fixed(base_cell * scale_factor);
    grain::apply_grain(&mut buf, w, h, strength, scaled_size, 0xC0FFEEu64);

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
fn apply_clarity(buf: &mut [f32], w: u32, h: u32, amount: f32, radius: i32) {
    let blurred = box_blur_lum(buf, w, h, radius);
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
fn apply_unsharp(buf: &mut [f32], w: u32, h: u32, amount: f32, radius: i32) {
    let blurred = box_blur_lum(buf, w, h, radius);
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

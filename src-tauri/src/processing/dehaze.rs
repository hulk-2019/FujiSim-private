//! Dark Channel Prior 去雾（He et al. 2009）+ Guided Filter 透射率平滑。
//!
//! 全图 RGB 操作，函数签名以 `&[f32]` / `&mut [f32]` 形式接收主缓冲。
//!
//! 用户值 `amount` ∈ [-100, 100]：
//! - 正向：去雾，结果朝 J = (I - A)/t + A 方向插值；
//! - 负向：加雾，结果朝灰阶融合方向插值。

use rayon::prelude::*;

const PATCH_RADIUS: i32 = 7; // 15×15 patch
const OMEGA: f32 = 0.95; // 保留少量雾感
const T_MIN: f32 = 0.1; // 透射率下限
const GF_RADIUS: i32 = 20; // guided filter box radius
const GF_EPS: f32 = 1e-3;

/// 入口：对 `buf`（RGB 平铺，长度 w*h*3）就地应用去雾，强度 amount ∈ [-100,100]。
pub fn apply_dehaze(buf: &mut [f32], w: u32, h: u32, amount: i32) {
    if amount == 0 {
        return;
    }
    let n = (w * h) as usize;
    let dark = compute_dark_channel(buf, w, h);
    let airlight = estimate_airlight(buf, &dark);
    let raw_t = transmission_map(buf, w, h, airlight);
    let guide = luminance(buf, n);
    let t = guided_filter(&guide, &raw_t, w, h, GF_RADIUS, GF_EPS);

    let k = amount as f32 / 100.0;
    if k > 0.0 {
        // 去雾：朝复原结果插值
        buf.par_chunks_mut(3).enumerate().for_each(|(i, px)| {
            let ti = t[i].max(T_MIN);
            for c in 0..3 {
                let j = (px[c] - airlight[c]) / ti + airlight[c];
                px[c] = px[c] * (1.0 - k) + j.clamp(0.0, 1.0) * k;
            }
        });
    } else {
        // 加雾：朝大气光融合
        let kk = -k;
        buf.par_chunks_mut(3).for_each(|px| {
            for c in 0..3 {
                let fog = px[c] * 0.7 + airlight[c] * 0.3;
                px[c] = (px[c] * (1.0 - kk) + fog * kk).clamp(0.0, 1.0);
            }
        });
    }
}

fn compute_dark_channel(buf: &[f32], w: u32, h: u32) -> Vec<f32> {
    let w_i = w as i32;
    let h_i = h as i32;
    let n = (w * h) as usize;
    let mut dark = vec![0f32; n];
    dark.par_chunks_mut(w as usize)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..w_i {
                let mut m = f32::INFINITY;
                for dy in -PATCH_RADIUS..=PATCH_RADIUS {
                    let ny = y as i32 + dy;
                    if ny < 0 || ny >= h_i {
                        continue;
                    }
                    for dx in -PATCH_RADIUS..=PATCH_RADIUS {
                        let nx = x + dx;
                        if nx < 0 || nx >= w_i {
                            continue;
                        }
                        let i = ((ny * w_i + nx) * 3) as usize;
                        m = m.min(buf[i]).min(buf[i + 1]).min(buf[i + 2]);
                    }
                }
                row[x as usize] = m;
            }
        });
    dark
}

fn estimate_airlight(buf: &[f32], dark: &[f32]) -> [f32; 3] {
    // 取 dark channel 前 0.1% 最亮像素，对应 buf 中 RGB 最大亮度
    let n = dark.len();
    let take = (n / 1000).max(1);
    let mut idx: Vec<usize> = (0..n).collect();
    // 只需要前 take 个最大值（顺序无所谓），用 select_nth_unstable_by 做 O(n) 部分排序，
    // 比 sort_by 的 O(n log n) 更快——1280×1280 的预览能省下不少 ms。
    let pivot = take.saturating_sub(1).min(n - 1);
    idx.select_nth_unstable_by(pivot, |&a, &b| {
        dark[b]
            .partial_cmp(&dark[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut best = [0f32; 3];
    let mut best_intensity = -1f32;
    for &i in idx.iter().take(take) {
        let r = buf[i * 3];
        let g = buf[i * 3 + 1];
        let b = buf[i * 3 + 2];
        let intensity = r + g + b;
        if intensity > best_intensity {
            best_intensity = intensity;
            best = [r, g, b];
        }
    }
    best
}

fn transmission_map(buf: &[f32], w: u32, h: u32, a: [f32; 3]) -> Vec<f32> {
    // 对 I/A 计算 dark channel，t = 1 - omega * darkchannel(I/A)
    let n = (w * h) as usize;
    let mut normalized = vec![0f32; n * 3];
    for i in 0..n {
        for c in 0..3 {
            normalized[i * 3 + c] = (buf[i * 3 + c] / a[c].max(1e-6)).clamp(0.0, 1.0);
        }
    }
    let dark = compute_dark_channel(&normalized, w, h);
    dark.iter()
        .map(|d| (1.0 - OMEGA * d).clamp(0.0, 1.0))
        .collect()
}

fn luminance(buf: &[f32], n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| 0.2126 * buf[i * 3] + 0.7152 * buf[i * 3 + 1] + 0.0722 * buf[i * 3 + 2])
        .collect()
}

/// Guided Filter（He et al. 2010）。`guide` 为引导图（亮度），`p` 为输入信号（透射率）。
/// 输出为平滑后的透射率，长度 = w*h。
fn guided_filter(guide: &[f32], p: &[f32], w: u32, h: u32, r: i32, eps: f32) -> Vec<f32> {
    let mean_i = box_blur_1c(guide, w, h, r);
    let mean_p = box_blur_1c(p, w, h, r);
    let ip: Vec<f32> = guide.iter().zip(p).map(|(a, b)| a * b).collect();
    let mean_ip = box_blur_1c(&ip, w, h, r);
    let ii: Vec<f32> = guide.iter().map(|x| x * x).collect();
    let mean_ii = box_blur_1c(&ii, w, h, r);

    let n = guide.len();
    let mut a = vec![0f32; n];
    let mut b = vec![0f32; n];
    for i in 0..n {
        let var_i = mean_ii[i] - mean_i[i] * mean_i[i];
        let cov_ip = mean_ip[i] - mean_i[i] * mean_p[i];
        a[i] = cov_ip / (var_i + eps);
        b[i] = mean_p[i] - a[i] * mean_i[i];
    }
    let mean_a = box_blur_1c(&a, w, h, r);
    let mean_b = box_blur_1c(&b, w, h, r);
    (0..n).map(|i| mean_a[i] * guide[i] + mean_b[i]).collect()
}

fn box_blur_1c(src: &[f32], w: u32, h: u32, r: i32) -> Vec<f32> {
    let w_i = w as i32;
    let h_i = h as i32;
    let n = (w * h) as usize;
    let mut tmp = vec![0f32; n];
    tmp.par_chunks_mut(w as usize)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..w_i {
                let mut sum = 0f32;
                let mut cnt = 0f32;
                for dx in -r..=r {
                    let nx = x + dx;
                    if nx >= 0 && nx < w_i {
                        sum += src[(y as i32 * w_i + nx) as usize];
                        cnt += 1.0;
                    }
                }
                row[x as usize] = sum / cnt;
            }
        });
    let mut out = vec![0f32; n];
    out.par_chunks_mut(w as usize)
        .enumerate()
        .for_each(|(y, row)| {
            let y = y as i32;
            for x in 0..w_i {
                let mut sum = 0f32;
                let mut cnt = 0f32;
                for dy in -r..=r {
                    let ny = y + dy;
                    if ny >= 0 && ny < h_i {
                        sum += tmp[(ny * w_i + x) as usize];
                        cnt += 1.0;
                    }
                }
                row[x as usize] = sum / cnt;
            }
        });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthesize_hazy(w: u32, h: u32) -> Vec<f32> {
        // 中性灰加白雾：base 0.5，再朝 1.0 偏移 0.3
        let n = (w * h * 3) as usize;
        let mut buf = vec![0.5f32; n];
        for v in buf.iter_mut() {
            *v = *v * 0.7 + 0.3;
        }
        // 给中心区域注入一点低饱和细节
        for y in 30..50 {
            for x in 30..50 {
                let i = ((y * w + x) * 3) as usize;
                buf[i] = 0.4;
                buf[i + 1] = 0.4;
                buf[i + 2] = 0.5;
            }
        }
        buf
    }

    fn rgb_std(buf: &[f32]) -> f32 {
        let mean: f32 = buf.iter().sum::<f32>() / buf.len() as f32;
        let var: f32 = buf.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / buf.len() as f32;
        var.sqrt()
    }

    #[test]
    fn dehaze_zero_is_identity() {
        let mut buf = synthesize_hazy(80, 80);
        let copy = buf.clone();
        apply_dehaze(&mut buf, 80, 80, 0);
        assert_eq!(buf, copy);
    }

    #[test]
    fn dehaze_positive_increases_variance() {
        let mut buf = synthesize_hazy(80, 80);
        let before = rgb_std(&buf);
        apply_dehaze(&mut buf, 80, 80, 100);
        let after = rgb_std(&buf);
        assert!(
            after > before,
            "after std {} should exceed before {}",
            after,
            before
        );
    }
}

//! Dark Channel Prior 去雾（He et al. 2009）+ Guided Filter 透射率平滑。
//!
//! 全图 RGB 操作，函数签名以 `&[f32]` / `&mut [f32]` 形式接收主缓冲。
//!
//! 用户值 `amount` ∈ [-100, 100]：
//! - 正向：去雾，结果朝 J = (I - A)/t + A 方向插值；
//! - 负向：加雾，结果朝灰阶融合方向插值。
//!
//! 性能优化：
//! - 暗通道用分离式两遍滑动窗口 min（O(n) 替代 O(patch²×n)）

#![allow(clippy::needless_range_loop)]
//! - 盒式模糊用前缀和（O(n) 替代 O(radius×n)）
//! - 热循环用 rayon 并行化
//! - guided_filter 内部复用 buffer 避免反复 alloc

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

// ── 分离式滑动窗口 min（O(n) 替代 O(patch²×n)）───────────────────────────────
//
// 暗通道 = min over patch of min(R,G,B)。
// 等价于：先对每个像素算 per-pixel min = min(R,G,B)，
// 再对这张单通道图做 2D patch-min = 水平滑窗 min → 垂直滑窗 min。

/// 计算暗通道：先逐像素 min(R,G,B)，再分离式两遍滑窗 patch-min。
fn compute_dark_channel(buf: &[f32], w: u32, h: u32) -> Vec<f32> {
    let w_us = w as usize;
    let h_us = h as usize;
    let n = w_us * h_us;
    let r = PATCH_RADIUS;

    // Step 1: per-pixel min(R,G,B)
    let mut per_pixel_min: Vec<f32> = vec![0.0; n];
    per_pixel_min
        .par_chunks_mut(w_us)
        .enumerate()
        .for_each(|(y, row)| {
            let base = y * w_us;
            for x in 0..w_us {
                let i = (base + x) * 3;
                row[x] = buf[i].min(buf[i + 1]).min(buf[i + 2]);
            }
        });

    // Step 2: horizontal sliding-window min (radius r)
    let mut h_min: Vec<f32> = vec![0.0; n];
    h_min.par_chunks_mut(w_us).enumerate().for_each(|(y, row)| {
        sliding_min_row(&per_pixel_min[y * w_us..(y + 1) * w_us], row, r, w_us);
    });

    // Step 3: vertical sliding-window min (radius r)
    let mut dark: Vec<f32> = vec![0.0; n];
    // Process columns in parallel chunks
    dark.par_chunks_mut(w_us).enumerate().for_each(|(y, row)| {
        for x in 0..w_us {
            let y_start = y.saturating_sub(r as usize);
            let y_end = (y + r as usize + 1).min(h_us);
            let mut m = f32::INFINITY;
            for yy in y_start..y_end {
                m = m.min(h_min[yy * w_us + x]);
            }
            row[x] = m;
        }
    });

    dark
}

/// 对单行做滑动窗口最小值（dequeue 算法，严格 O(n)）。
fn sliding_min_row(src: &[f32], dst: &mut [f32], r: i32, w: usize) {
    // 使用单调双端队列实现 O(n) 滑窗最小值
    let r_us = r as usize;
    let window = 2 * r_us + 1;
    let n = src.len();
    // deque stores indices in increasing order of their values
    let mut deque: Vec<usize> = Vec::with_capacity(window);
    let mut front = 0usize;
    let mut back = 0usize; // deque[front..back) is the active range

    for i in 0..n {
        // remove elements from back that are >= current
        while back > front && src[deque[back - 1]] >= src[i] {
            back -= 1;
        }
        // push current index
        if deque.len() <= back {
            deque.push(i);
        } else {
            deque[back] = i;
        }
        back += 1;

        // remove elements from front that are out of window
        let win_start = i.saturating_sub(window - 1);
        while front < back && deque[front] < win_start {
            front += 1;
        }

        // the minimum for the window ending at i is at deque[front]
        // but we output at position i - r (center of window)
        if i >= r_us {
            let out_idx = i - r_us;
            if out_idx < w {
                dst[out_idx] = src[deque[front]];
            }
        }
    }

    // Handle tail: windows whose center is past the last full window
    // For positions near the right edge, the window is truncated
    for center in n.saturating_sub(r_us)..w {
        let y_start = center.saturating_sub(r_us);
        let y_end = (center + r_us + 1).min(n);
        let mut m = f32::INFINITY;
        for j in y_start..y_end {
            m = m.min(src[j]);
        }
        dst[center] = m;
    }
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
    // 并行化 I/A 归一化
    normalized
        .par_chunks_mut(3)
        .enumerate()
        .for_each(|(i, px)| {
            for c in 0..3 {
                px[c] = (buf[i * 3 + c] / a[c].max(1e-6)).clamp(0.0, 1.0);
            }
        });
    let dark = compute_dark_channel(&normalized, w, h);
    dark.par_iter()
        .map(|d| (1.0 - OMEGA * d).clamp(0.0, 1.0))
        .collect()
}

fn luminance(buf: &[f32], n: usize) -> Vec<f32> {
    (0..n)
        .into_par_iter()
        .map(|i| 0.2126 * buf[i * 3] + 0.7152 * buf[i * 3 + 1] + 0.0722 * buf[i * 3 + 2])
        .collect()
}

/// Guided Filter（He et al. 2010）。`guide` 为引导图（亮度），`p` 为输入信号（透射率）。
/// 输出为平滑后的透射率，长度 = w*h。
/// 内部复用 buffer 避免反复 alloc。
fn guided_filter(guide: &[f32], p: &[f32], w: u32, h: u32, r: i32, eps: f32) -> Vec<f32> {
    let n = guide.len();

    // Pre-allocate scratch buffers for box_blur (avoids 6× alloc inside box_blur)
    let mut scratch1 = vec![0f32; n];
    let mut scratch2 = vec![0f32; n];

    let mut mean_i = vec![0f32; n];
    box_blur_1c_into(guide, w, h, r, &mut scratch1, &mut scratch2, &mut mean_i);
    let mut mean_p = vec![0f32; n];
    box_blur_1c_into(p, w, h, r, &mut scratch1, &mut scratch2, &mut mean_p);

    let ip: Vec<f32> = guide.par_iter().zip(p).map(|(a, b)| a * b).collect();
    let mut mean_ip = vec![0f32; n];
    box_blur_1c_into(&ip, w, h, r, &mut scratch1, &mut scratch2, &mut mean_ip);

    let ii: Vec<f32> = guide.par_iter().map(|x| x * x).collect();
    let mut mean_ii = vec![0f32; n];
    box_blur_1c_into(&ii, w, h, r, &mut scratch1, &mut scratch2, &mut mean_ii);

    let mut a = vec![0f32; n];
    let mut b = vec![0f32; n];
    a.par_iter_mut()
        .zip(b.par_iter_mut())
        .enumerate()
        .for_each(|(i, (a_out, b_out))| {
            let mi = mean_i[i];
            let mp = mean_p[i];
            let mii = mean_ii[i];
            let mip = mean_ip[i];
            let var_i = mii - mi * mi;
            let cov_ip = mip - mi * mp;
            *a_out = cov_ip / (var_i + eps);
            *b_out = mp - *a_out * mi;
        });

    let mut mean_a = vec![0f32; n];
    box_blur_1c_into(&a, w, h, r, &mut scratch1, &mut scratch2, &mut mean_a);
    let mut mean_b = vec![0f32; n];
    box_blur_1c_into(&b, w, h, r, &mut scratch1, &mut scratch2, &mut mean_b);

    mean_a
        .par_iter()
        .zip(&mean_b)
        .zip(guide)
        .map(|((&ma, &mb), &g)| ma * g + mb)
        .collect()
}

// ── 前缀和盒式模糊（O(n) 替代 O(radius×n)）───────────────────────────────────

/// 前缀和盒式模糊，结果写入 `out`。`tmp1`/`tmp2` 为可复用的 scratch buffer。
fn box_blur_1c_into(
    src: &[f32],
    w: u32,
    h: u32,
    r: i32,
    tmp1: &mut [f32],
    tmp2: &mut [f32],
    out: &mut [f32],
) {
    let w_us = w as usize;
    let h_us = h as usize;
    let r_us = r as usize;
    let n = w_us * h_us;
    assert_eq!(src.len(), n);
    assert_eq!(tmp1.len(), n);
    assert_eq!(tmp2.len(), n);
    assert_eq!(out.len(), n);

    // Horizontal pass with prefix sum
    tmp1.par_chunks_mut(w_us).enumerate().for_each(|(y, row)| {
        let base = y * w_us;
        // Build prefix sum
        let mut prefix = vec![0.0f64; w_us + 1];
        for x in 0..w_us {
            prefix[x + 1] = prefix[x] + src[base + x] as f64;
        }
        // Compute box average for each pixel
        for x in 0..w_us {
            let x_start = x.saturating_sub(r_us);
            let x_end = (x + r_us + 1).min(w_us);
            let cnt = (x_end - x_start) as f64;
            row[x] = ((prefix[x_end] - prefix[x_start]) / cnt) as f32;
        }
    });

    // Vertical pass with prefix sum
    out.par_chunks_mut(w_us).enumerate().for_each(|(y, row)| {
        let y_start = y.saturating_sub(r_us);
        let y_end = (y + r_us + 1).min(h_us);
        let cnt = (y_end - y_start) as f32;
        for x in 0..w_us {
            let mut sum = 0.0f64;
            for yy in y_start..y_end {
                sum += tmp1[yy * w_us + x] as f64;
            }
            row[x] = (sum / cnt as f64) as f32;
        }
    });
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

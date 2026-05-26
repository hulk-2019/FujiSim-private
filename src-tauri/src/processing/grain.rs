//! Grain (film grain) effect — CPU implementation.

/// Apply grain noise to a raw RGB buffer.
///
/// # Parameters (all 0–100 sliders)
///
/// - `grain_amount`   → amplitude = (amount/100)² × 0.12
/// - `grain_size`     → cell_size = 1 + (size/100) × 3   (1 px – 4 px)
/// - `grain_roughness`→ roughness_mix = roughness/100
/// - `grain_color`    → color_independence = color/100
/// - `scale_factor`   → multiplier for cell_size at high resolutions
/// - `seed`           → deterministic seed
pub fn apply_grain(
    buf: &mut [f32],
    width: u32,
    height: u32,
    grain_amount: f32,
    grain_size: f32,
    grain_roughness: f32,
    grain_color: f32,
    scale_factor: u32,
    seed: u64,
) {
    if grain_amount <= 0.0 {
        return;
    }

    let amount = (grain_amount / 100.0).clamp(0.0, 1.0);
    let size = (grain_size / 100.0).clamp(0.0, 1.0);
    let roughness_mix = (grain_roughness / 100.0).clamp(0.0, 1.0);
    let color_independence = (grain_color / 100.0).clamp(0.0, 1.0);

    let amplitude = amount * amount * 0.12;
    let base_cell = 1.0 + size * 3.0;
    let cell_size = base_cell * scale_factor as f32;

    for y in 0..height {
        for x in 0..width {
            let cx = (x as f32 / cell_size).floor() as u64;
            let cy = (y as f32 / cell_size).floor() as u64;

            // First layer noise (cell-based)
            let s1 = cx.wrapping_mul(374761393).wrapping_add(cy.wrapping_mul(668265263)).wrapping_add(seed);
            let noise1 = hash_to_f32(s1) * 2.0 - 1.0;

            // Second layer fine noise (pixel-based)
            let s2 = (x as u64).wrapping_mul(127).wrapping_add((y as u64).wrapping_mul(311)).wrapping_add(seed);
            let noise2 = hash_to_f32(s2) * 2.0 - 1.0;

            // Roughness blends the two layers
            let noise = noise1 * (1.0 - roughness_mix) + noise2 * roughness_mix;

            // Per-channel offsets with color independence
            let r_offset = noise * amplitude;
            let g_seed = s2.wrapping_add(7919);
            let b_seed = s2.wrapping_add(104729);
            let g_n = hash_to_f32(g_seed) * 2.0 - 1.0;
            let b_n = hash_to_f32(b_seed) * 2.0 - 1.0;
            let g_offset = (noise * (1.0 - color_independence) + g_n * color_independence) * amplitude;
            let b_offset = (noise * (1.0 - color_independence) + b_n * color_independence) * amplitude;

            let idx = ((y * width + x) * 3) as usize;
            if idx + 2 < buf.len() {
                buf[idx] = (buf[idx] + r_offset).clamp(0.0, 1.0);
                buf[idx + 1] = (buf[idx + 1] + g_offset).clamp(0.0, 1.0);
                buf[idx + 2] = (buf[idx + 2] + b_offset).clamp(0.0, 1.0);
            }
        }
    }
}

/// Multiply-hash → [0, 1) f32.
fn hash_to_f32(hash: u64) -> f32 {
    let h = hash.wrapping_mul(0x45d9f3b);
    let h = (h ^ (h >> 16)).wrapping_mul(0x45d9f3b);
    let h = h ^ (h >> 16);
    (h as f32) / (u32::MAX as f32)
}

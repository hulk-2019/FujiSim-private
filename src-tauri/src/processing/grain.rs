//! Grain (film grain) effect — CPU implementation.

/// Apply grain noise to a linear RGB float buffer (`[r, g, b, r, g, b, ...]`).
///
/// # Parameters (all 0–100 sliders)
///
/// - `grain_amount`   → overall intensity: amplitude = (amount/100)² × 0.20
/// - `grain_size`     → cell_size = 1 + (size/100) × 7  (1 px – 8 px)
/// - `grain_roughness`→ roughness/100 blends cell noise with pixel noise
/// - `grain_color`    → color/100 adds per-channel tint on top
/// - `scale_factor`   → multiplier for cell_size at high resolutions
/// - `seed`           → deterministic seed
#[allow(clippy::too_many_arguments)]
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
    let color_tint = (grain_color / 100.0).clamp(0.0, 1.0);

    let amplitude = amount * amount * 0.20;
    let base_cell = 1.0 + size * 7.0;
    let cell_size = base_cell * scale_factor as f32;

    for y in 0..height {
        for x in 0..width {
            let cx = (x as f32 / cell_size).floor() as u64;
            let cy = (y as f32 / cell_size).floor() as u64;

            // Cell-based noise (smooth within cell, blocky between cells)
            let s1 = cx.wrapping_mul(374761393).wrapping_add(cy.wrapping_mul(668265263)).wrapping_add(seed);
            let n1 = hash_to_norm(s1);

            // Pixel-based noise (fine, per-pixel variation)
            let s2 = (x as u64).wrapping_mul(127).wrapping_add((y as u64).wrapping_mul(311)).wrapping_add(seed);
            let n2 = hash_to_norm(s2);

            // Roughness: high → more cell noise (blocky/coarse), low → more pixel noise (smooth)
            let noise = n1 * roughness_mix + n2 * (1.0 - roughness_mix);

            // Luminance mask: grain strongest at mid-grey, vanishes at black/white
            let idx = ((y * width + x) * 3) as usize;
            if idx + 2 >= buf.len() {
                continue;
            }
            let r = buf[idx];
            let g = buf[idx + 1];
            let b = buf[idx + 2];
            let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let mask = 4.0 * lum * (1.0 - lum);

            // Shared luminance grain (all channels)
            let shared = noise * amplitude * mask;

            // Color tint: per-channel independent noise added on top
            // color_tint 0 → no tint (neutral grain)
            // color_tint 100 → strong per-channel color deviation
            let g_seed = s2.wrapping_add(7919);
            let b_seed = s2.wrapping_add(104729);
            let g_n = hash_to_norm(g_seed);
            let b_n = hash_to_norm(b_seed);
            let tint_amp = color_tint * amplitude * 0.5;

            buf[idx] = (r + shared).clamp(0.0, 1.0);
            buf[idx + 1] = (g + shared + g_n * tint_amp * mask).clamp(0.0, 1.0);
            buf[idx + 2] = (b + shared + b_n * tint_amp * mask).clamp(0.0, 1.0);
        }
    }
}

/// Hash → Box-Muller → approximate standard-normal distribution.
/// Returns a value with ~99.7% probability in [-3, 3], clamped to [-4, 4].
fn hash_to_norm(hash: u64) -> f32 {
    let h = hash.wrapping_mul(0x45d9f3b).wrapping_add(0x15ebaa000);
    let u1 = ((h >> 32) as u32) as f32 / u32::MAX as f32;
    let u2 = (h as u32) as f32 / u32::MAX as f32;
    let u1c = u1.max(1e-6);
    let z = (-2.0 * u1c.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos();
    z.clamp(-4.0, 4.0)
}
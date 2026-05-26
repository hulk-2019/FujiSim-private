struct Params {
    width: u32,
    height: u32,
    scale_factor: u32,
    seed: u32,
    grain_amount: f32,
    grain_size: f32,
    grain_roughness: f32,
    grain_color: f32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Params;

fn pcg_hash(seed_in: u32) -> u32 {
    var state: u32 = seed_in * 747796405u + 2891336453u;
    let word: u32 = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

// Box-Muller: two uniform → one standard-normal sample.
fn box_muller(u1: f32, u2: f32) -> f32 {
    let u1c = max(u1, 1e-6);
    return sqrt(-2.0 * log(u1c)) * cos(6.2831853 * u2);
}

// Hash → two uniform → one normal.
fn hash_to_norm(h: u32) -> f32 {
    let u1 = f32(pcg_hash(h)) / 4294967295.0;
    let u2 = f32(pcg_hash(h ^ 0x9E3779B9u)) / 4294967295.0;
    return clamp(box_muller(u1, u2), -4.0, 4.0);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    var c = textureLoad(src, coord, 0).rgb;

    if (p.grain_amount > 0.0) {
        let amount = clamp(p.grain_amount / 100.0, 0.0, 1.0);
        let size = clamp(p.grain_size / 100.0, 0.0, 1.0);
        let roughness_mix = clamp(p.grain_roughness / 100.0, 0.0, 1.0);
        let color_tint = clamp(p.grain_color / 100.0, 0.0, 1.0);

        let amplitude = amount * amount * 0.20;
        let base_cell = 1.0 + size * 7.0;
        let cell = max(1u, u32(base_cell * f32(p.scale_factor)));

        // Luminance mask: grain strongest at mid-grey, vanishes at black/white
        let lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        let mask = 4.0 * lum * (1.0 - lum);

        // Cell-based noise (smooth within cell, blocky between cells)
        let cx = gid.x / cell;
        let cy = gid.y / cell;
        let n1 = hash_to_norm(cx * 1664525u + cy * 1013904223u + p.seed);

        // Pixel-based noise (fine, per-pixel variation)
        let px = gid.x * 127u + gid.y * 311u + p.seed;
        let n2 = hash_to_norm(px);

        // Roughness: high → more cell noise (blocky/coarse), low → more pixel noise (smooth)
        let noise = n1 * roughness_mix + n2 * (1.0 - roughness_mix);

        // Shared luminance grain (all channels)
        let grain_base = noise * amplitude * mask;

        // Color tint: per-channel independent noise added on top
        let g_n = hash_to_norm(px + 7919u);
        let b_n = hash_to_norm(px + 104729u);
        let tint_amp = color_tint * amplitude * 0.5;

        c.r = clamp(c.r + grain_base, 0.0, 1.0);
        c.g = clamp(c.g + grain_base + g_n * tint_amp * mask, 0.0, 1.0);
        c.b = clamp(c.b + grain_base + b_n * tint_amp * mask, 0.0, 1.0);
    }
    textureStore(dst, coord, vec4<f32>(c, 1.0));
}

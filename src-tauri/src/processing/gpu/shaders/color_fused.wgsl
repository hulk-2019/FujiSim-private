// color_fused.wgsl — GPU translation of CPU pipeline steps [1]–[10].
//
// Uniform field order MUST stay in sync with FilterUniforms in
// src-tauri/src/processing/gpu/uniforms.rs (std140 layout, 144 bytes).
// naga inserts 8 bytes of padding after has_master_curve automatically
// because split_hi is a vec4<f32> (16-byte aligned). Do NOT add explicit
// padding here.

struct Uniforms {
    wb_shift_r: f32, wb_shift_b: f32,
    exposure: f32,
    brightness: f32, contrast: f32,
    highlight: f32, shadow: f32, white: f32, black: f32,
    has_master_curve: u32,
    split_hi: vec4<f32>,
    split_sh: vec4<f32>,
    channel_shift: vec4<f32>,
    vibrance: f32, saturation: f32,
    fade: f32,
    monochrome: u32,
    mono_tint: vec4<f32>,
    width: u32, height: u32,
    _pad: vec2<u32>,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u: Uniforms;
// curve_lut is a 1024 × 4 r16float texture: row 0 = R, 1 = G, 2 = B, 3 = master.
@group(0) @binding(3) var curve_lut: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;

fn lerp(a: f32, b: f32, t: f32) -> f32 { return a + (b - a) * t; }

fn sample_curve(value: f32, row: i32) -> f32 {
    let v = clamp(value, 0.0, 1.0);
    return textureSampleLevel(curve_lut, samp, vec2<f32>(v, (f32(row) + 0.5) / 4.0), 0.0).r;
}

fn rgb_to_hsl(c: vec3<f32>) -> vec3<f32> {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    let l = (mx + mn) * 0.5;
    var s = 0.0;
    var h = 0.0;
    if (mx != mn) {
        let d = mx - mn;
        if (l > 0.5) { s = d / (2.0 - mx - mn); } else { s = d / (mx + mn); }
        if (mx == c.r) {
            h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b);
        } else if (mx == c.g) {
            h = (c.b - c.r) / d + 2.0;
        } else {
            h = (c.r - c.g) / d + 4.0;
        }
        h = h / 6.0;
    }
    return vec3<f32>(h, s, l);
}

fn hue_to_rgb(p: f32, q: f32, t_in: f32) -> f32 {
    var t = t_in;
    if (t < 0.0) { t = t + 1.0; }
    if (t > 1.0) { t = t - 1.0; }
    if (t < 1.0/6.0) { return p + (q - p) * 6.0 * t; }
    if (t < 0.5) { return q; }
    if (t < 2.0/3.0) { return p + (q - p) * (2.0/3.0 - t) * 6.0; }
    return p;
}

fn hsl_to_rgb(hsl: vec3<f32>) -> vec3<f32> {
    let h = hsl.x; let s = hsl.y; let l = hsl.z;
    if (s == 0.0) { return vec3<f32>(l, l, l); }
    let q = select(l + s - l * s, l * (1.0 + s), l < 0.5);
    let p = 2.0 * l - q;
    return vec3<f32>(hue_to_rgb(p, q, h + 1.0/3.0),
                     hue_to_rgb(p, q, h),
                     hue_to_rgb(p, q, h - 1.0/3.0));
}

// Hermite smoothstep: 3t²-2t³ (matches CPU cubic_falloff).
fn cubic_falloff(t: f32) -> f32 {
    let tc = clamp(t, 0.0, 1.0);
    return tc * tc * (3.0 - 2.0 * tc);
}

// Rec.709 luminance (matches CPU apply_tone_segments_pixel and color::luminance).
fn luma709(c: vec3<f32>) -> f32 {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// [4] 4-segment tone: hue-preserving scale via luma ratio (matches CPU apply_tone_segments_pixel).
// amount values are raw i32-cast-to-f32 in range [-100, 100].
fn apply_tone_segments(c: vec3<f32>, highlight: f32, shadow: f32, white: f32, black: f32) -> vec3<f32> {
    let l = luma709(c);
    var delta = 0.0;
    if (highlight != 0.0 && l > 0.7) {
        delta += (highlight / 100.0) * cubic_falloff((l - 0.7) / 0.3) * 0.3;
    }
    if (white != 0.0 && l > 0.85) {
        delta += (white / 100.0) * cubic_falloff((l - 0.85) / 0.15) * 0.3;
    }
    if (shadow != 0.0 && l < 0.3) {
        delta += (shadow / 100.0) * cubic_falloff((0.3 - l) / 0.3) * 0.3;
    }
    if (black != 0.0 && l < 0.15) {
        delta += (black / 100.0) * cubic_falloff((0.15 - l) / 0.15) * 0.3;
    }
    if (delta == 0.0 || l <= 0.0001) {
        return c;
    }
    // Hue-preserving: scale RGB so luma increases by delta.
    let scale = (l + delta) / l;
    return c * scale;
}

// [7a] Vibrance: low-saturation pixels boosted more.
// weight = (1 - s)^2 (matches CPU apply_vibrance_pixel).
fn apply_vibrance(c: vec3<f32>, amount: f32) -> vec3<f32> {
    if (abs(amount) < 0.001) { return c; }
    var hsl = rgb_to_hsl(c);
    let k = amount / 100.0;
    let weight = (1.0 - hsl.y) * (1.0 - hsl.y);
    hsl.y = clamp(hsl.y + k * weight * hsl.y, 0.0, 1.0);
    return hsl_to_rgb(hsl);
}

// [7b] Saturation: additive in HSL space (matches CPU apply_saturation_pixel).
fn apply_saturation(c: vec3<f32>, amount: f32) -> vec3<f32> {
    if (abs(amount) < 0.001) { return c; }
    var hsl = rgb_to_hsl(c);
    let k = amount / 100.0;
    hsl.y = clamp(hsl.y + k, 0.0, 1.0);
    return hsl_to_rgb(hsl);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= u.width || gid.y >= u.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    var c = textureLoad(src, coord, 0).rgb;

    // [1] WB shift: multiplicative gain per axis (matches CPU apply_wb_shift).
    // wb_shift_r/b are raw i32 cast to f32 (range -9..+9); each step ≈ 2% gain.
    c.r = c.r * (1.0 + u.wb_shift_r * 0.02);
    c.b = c.b * (1.0 + u.wb_shift_b * 0.02);

    // [2] Exposure: linear gain 2^EV (matches CPU apply_exposure_pixel).
    let gain = pow(2.0, u.exposure);
    c = c * gain;

    // [3] Brightness: linear offset, amount/200 full-scale (matches CPU apply_brightness_pixel).
    // brightness is raw i32 cast to f32 (range -100..100); full-scale ±0.5.
    c = c + vec3<f32>(u.brightness * 0.005);

    // [3] Contrast: pivot at 0.5, factor = 1 + amount/100 (matches CPU apply_contrast_pixel).
    let pivot = 0.5;
    let cf = 1.0 + u.contrast * 0.01;
    c = (c - pivot) * cf + pivot;

    // [4] 4-segment tone (highlight/shadow/white/black) — hue-preserving via luma ratio.
    c = apply_tone_segments(c, u.highlight, u.shadow, u.white, u.black);

    // [5] Per-channel tone curves (R/G/B rows of curve_lut).
    // Rows already encode: rc → user_rgb → user_per_ch (baked in curves_bake.rs).
    // Row 3 is reserved/zeros and is never sampled.
    c.r = sample_curve(c.r, 0);
    c.g = sample_curve(c.g, 1);
    c.b = sample_curve(c.b, 2);

    // [6] Split toning — luminance-weighted multiplicative tint (Rec.709 luma, matches CPU color::luminance).
    let l2 = luma709(c);
    let hi = max(l2 - 0.5, 0.0) * 2.0;
    let sh = max(0.5 - l2, 0.0) * 2.0;
    c.r = c.r * lerp(1.0, u.split_hi.r, hi);
    c.g = c.g * lerp(1.0, u.split_hi.g, hi);
    c.b = c.b * lerp(1.0, u.split_hi.b, hi);
    c.r = c.r * lerp(1.0, u.split_sh.r, sh);
    c.g = c.g * lerp(1.0, u.split_sh.g, sh);
    c.b = c.b * lerp(1.0, u.split_sh.b, sh);

    // Channel shift: pre-scaled by 0.05 in FilterUniforms::from_settings (matches CPU).
    c = c + u.channel_shift.rgb;

    // [7] Vibrance then saturation (both in HSL space).
    // No clamp here — CPU apply_vibrance_pixel/apply_saturation_pixel also see
    // possibly out-of-range values after channel_shift.
    c = apply_vibrance(c, u.vibrance);
    c = apply_saturation(c, u.saturation);

    // [9] Fade: blend toward cream floor (matches CPU profile.fade logic).
    // Step [8] (Color Chrome Effect) was removed from the project (commit 673e55f).
    if (u.fade > 0.0) {
        let f = u.fade;
        c.r = c.r * (1.0 - f) + 0.08 * f;
        c.g = c.g * (1.0 - f) + 0.08 * f;
        c.b = c.b * (1.0 - f) + 0.10 * f;
    }

    // [10] Monochrome: Rec.601 luma × per-channel tint (matches CPU monochrome step).
    if (u.monochrome != 0u) {
        let y = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
        c = vec3<f32>(y * u.mono_tint.r, y * u.mono_tint.g, y * u.mono_tint.b);
    }

    c = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    textureStore(dst, coord, vec4<f32>(c, 1.0));
}

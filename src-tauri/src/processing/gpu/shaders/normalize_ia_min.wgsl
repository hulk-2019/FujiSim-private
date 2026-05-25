// Normalize I/A and compute per-pixel min(R/A_r, G/A_g, B/A_b) → R32Float.
// Combines two CPU steps: normalize I/A + per-pixel min, saving one dispatch.

struct Params {
    width: u32, height: u32,
    ar: f32, ag: f32, ab: f32,
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> p: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    let c = textureLoad(src, coord, 0).rgb;
    let nr = clamp(c.r / max(p.ar, 1e-6), 0.0, 1.0);
    let ng = clamp(c.g / max(p.ag, 1e-6), 0.0, 1.0);
    let nb = clamp(c.b / max(p.ab, 1e-6), 0.0, 1.0);
    let m: f32 = min(nr, min(ng, nb));
    textureStore(dst, coord, vec4<f32>(m, 0.0, 0.0, 0.0));
}
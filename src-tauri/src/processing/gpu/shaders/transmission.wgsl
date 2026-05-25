// Compute transmission: t = 1 - omega * dark(I/A).
// Input: dark channel of normalized I/A (R32Float).
// Output: raw transmission map (R32Float).

struct Params { width: u32, height: u32, omega: f32, _pad: u32 };
@group(0) @binding(0) var dark: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> p: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    let d = textureLoad(dark, coord, 0).r;
    let t: f32 = clamp(1.0 - p.omega * d, 0.0, 1.0);
    textureStore(dst, coord, vec4<f32>(t, 0.0, 0.0, 0.0));
}
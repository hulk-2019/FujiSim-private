// Compute luminance from Rgba16Float src → R32Float.
// Luma = 0.2126*R + 0.7152*G + 0.0722*B (Rec.709).

struct Params { width: u32, height: u32, _pad1: u32, _pad2: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> p: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    let c = textureLoad(src, coord, 0);
    let luma: f32 = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    textureStore(dst, coord, vec4<f32>(luma, 0.0, 0.0, 0.0));
}
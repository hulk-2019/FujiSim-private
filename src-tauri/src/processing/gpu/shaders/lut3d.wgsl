@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var lut3d: texture_3d<f32>;
@group(0) @binding(3) var samp: sampler;

struct Dim { width: u32, height: u32, _pad0: u32, _pad1: u32 };
@group(0) @binding(4) var<uniform> dim: Dim;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= dim.width || gid.y >= dim.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    let c = clamp(textureLoad(src, coord, 0).rgb, vec3<f32>(0.0), vec3<f32>(1.0));
    // Trilinear sample of the 3D LUT.
    let l = textureSampleLevel(lut3d, samp, c, 0.0).rgb;
    textureStore(dst, coord, vec4<f32>(l, 1.0));
}

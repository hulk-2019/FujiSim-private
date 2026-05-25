struct Params {
    width: u32, height: u32,
    clarity_amount: f32, sharpness_amount: f32,
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var blur_clarity: texture_2d<f32>;  // r16float, big radius
@group(0) @binding(3) var blur_sharp:   texture_2d<f32>;  // r16float, small radius
@group(0) @binding(4) var<uniform> p: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    var c = textureLoad(src, coord, 0).rgb;
    let lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    let bc = textureLoad(blur_clarity, coord, 0).r;
    let bs = textureLoad(blur_sharp, coord, 0).r;
    let dc = (lum - bc) * p.clarity_amount;
    let ds = (lum - bs) * p.sharpness_amount * 1.5;
    let delta = dc + ds;
    c = clamp(c + vec3<f32>(delta), vec3<f32>(0.0), vec3<f32>(1.0));
    textureStore(dst, coord, vec4<f32>(c, 1.0));
}

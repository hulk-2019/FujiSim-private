// Element-wise operations needed by guided filter.
// mode 0: ip = guide * p  (element multiply)
// mode 1: ii = guide * guide (element square)
// mode 2: a = cov_ip / (var_i + eps), b = mean_p - a * mean_i
// mode 3: out = mean_a * guide + mean_b

struct Params {
    width: u32, height: u32, mode: u32, eps: f32,
};
@group(0) @binding(0) var in0: texture_2d<f32>;
@group(0) @binding(1) var in1: texture_2d<f32>;
@group(0) @binding(2) var in2: texture_2d<f32>;
@group(0) @binding(3) var in3: texture_2d<f32>;
@group(0) @binding(4) var out0: texture_storage_2d<r32float, write>;
@group(0) @binding(5) var out1: texture_storage_2d<r32float, write>;
@group(0) @binding(6) var<uniform> p: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));

    if (p.mode == 0u) {
        // ip = guide * p
        let g = textureLoad(in0, coord, 0).r;
        let pp = textureLoad(in1, coord, 0).r;
        let result: f32 = g * pp;
        textureStore(out0, coord, vec4<f32>(result, 0.0, 0.0, 0.0));
    } else if (p.mode == 1u) {
        // ii = guide²
        let g = textureLoad(in0, coord, 0).r;
        let result: f32 = g * g;
        textureStore(out0, coord, vec4<f32>(result, 0.0, 0.0, 0.0));
    } else if (p.mode == 2u) {
        // guided a, b
        let mean_i  = textureLoad(in0, coord, 0).r;
        let mean_p  = textureLoad(in1, coord, 0).r;
        let mean_ip = textureLoad(in2, coord, 0).r;
        let mean_ii = textureLoad(in3, coord, 0).r;
        let var_i = mean_ii - mean_i * mean_i;
        let cov_ip = mean_ip - mean_i * mean_p;
        let a: f32 = cov_ip / (var_i + p.eps);
        let b: f32 = mean_p - a * mean_i;
        textureStore(out0, coord, vec4<f32>(a, 0.0, 0.0, 0.0));
        textureStore(out1, coord, vec4<f32>(b, 0.0, 0.0, 0.0));
    } else if (p.mode == 3u) {
        // guided merge: out = mean_a * guide + mean_b
        let mean_a = textureLoad(in0, coord, 0).r;
        let mean_b = textureLoad(in1, coord, 0).r;
        let guide  = textureLoad(in2, coord, 0).r;
        let result: f32 = mean_a * guide + mean_b;
        textureStore(out0, coord, vec4<f32>(result, 0.0, 0.0, 0.0));
    }
}
// Final dehaze apply: (I-A)/t+A interpolation.
// Positive amount: dehaze toward J = (I-A)/t + A.
// Negative amount: fog toward blend of original + airlight.
// Inputs: src (Rgba16Float), guided_t (R32Float), airlight uniform.

struct Params {
    width: u32, height: u32,
    amount: f32,  // ∈ [-100, 100]
    ar: f32, ag: f32, ab: f32,  // airlight RGB
    _p1: u32, _p2: u32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var t_tex: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> p: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    let c = textureLoad(src, coord, 0).rgb;
    let ti = max(textureLoad(t_tex, coord, 0).r, 0.1);  // T_MIN = 0.1
    let airlight = vec3<f32>(p.ar, p.ag, p.ab);
    let k = p.amount / 100.0;

    if (k > 0.0) {
        // Dehaze: interpolate toward restored image J = (I-A)/t + A
        var j = vec3<f32>(0.0);
        j.r = (c.r - airlight.r) / ti + airlight.r;
        j.g = (c.g - airlight.g) / ti + airlight.g;
        j.b = (c.b - airlight.b) / ti + airlight.b;
        j = clamp(j, vec3<f32>(0.0), vec3<f32>(1.0));
        let result = c * (1.0 - k) + j * k;
        textureStore(dst, coord, vec4<f32>(result, 1.0));
    } else {
        // Fog: blend toward airlight
        let kk = -k;
        let fog = c * 0.7 + airlight * 0.3;
        let result = clamp(c * (1.0 - kk) + fog * kk, vec3<f32>(0.0), vec3<f32>(1.0));
        textureStore(dst, coord, vec4<f32>(result, 1.0));
    }
}
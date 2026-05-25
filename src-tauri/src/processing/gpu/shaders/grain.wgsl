struct Params {
    width: u32, height: u32,
    cell: u32, seed: u32,
    amount: f32, _pad0: u32, _pad1: u32, _pad2: u32,
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Params;

fn pcg_hash(seed_in: u32) -> u32 {
    var state: u32 = seed_in * 747796405u + 2891336453u;
    let word: u32 = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn hash21(x: u32, y: u32, s: u32) -> f32 {
    let h = pcg_hash(x * 1664525u + y * 1013904223u + s);
    return f32(h) / 4294967295.0;
}

// Box-Muller from two uniforms → standard normal.
fn box_muller(u1: f32, u2: f32) -> f32 {
    let u1c = max(u1, 1e-6);
    return sqrt(-2.0 * log(u1c)) * cos(6.2831853 * u2);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    var c = textureLoad(src, coord, 0).rgb;

    if (p.amount > 0.0) {
        let cx = gid.x / p.cell;
        let cy = gid.y / p.cell;
        let u1 = hash21(cx, cy, p.seed);
        let u2 = hash21(cx, cy, p.seed ^ 0x9E3779B9u);
        let z = box_muller(u1, u2);
        let n = z * p.amount;
        let l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        let mask = 4.0 * l * (1.0 - l);
        c = clamp(c + vec3<f32>(n * mask), vec3<f32>(0.0), vec3<f32>(1.0));
    }
    textureStore(dst, coord, vec4<f32>(c, 1.0));
}

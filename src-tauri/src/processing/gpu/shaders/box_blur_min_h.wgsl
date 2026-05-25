// Horizontal sliding-window minimum on R32Float → R32Float.
// For each pixel, take min over [x-r .. x+r] in the same row.
// Radius = PATCH_RADIUS (7) for dark channel, or GF_RADIUS (20) not used here.

struct Params { width: u32, height: u32, radius: i32, _pad: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> p: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let x = i32(gid.x);
    let y = i32(gid.y);
    let r = p.radius;
    var m = 999.0;
    for (var dx = -r; dx <= r; dx = dx + 1) {
        let nx = x + dx;
        if (nx >= 0 && nx < i32(p.width)) {
            let v = textureLoad(src, vec2<i32>(nx, y), 0).r;
            m = min(m, v);
        }
    }
    let result: f32 = m;
    textureStore(dst, vec2<i32>(x, y), vec4<f32>(result, 0.0, 0.0, 0.0));
}
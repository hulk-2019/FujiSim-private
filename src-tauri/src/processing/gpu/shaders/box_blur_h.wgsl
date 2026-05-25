struct Params { width: u32, height: u32, radius: i32, _pad: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r16float, write>;
@group(0) @binding(2) var<uniform> p: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let y = i32(gid.y);
    let x = i32(gid.x);
    let r = p.radius;
    var sum = 0.0;
    var count = 0.0;
    for (var dx = -r; dx <= r; dx = dx + 1) {
        let nx = x + dx;
        if (nx >= 0 && nx < i32(p.width)) {
            let v = textureLoad(src, vec2<i32>(nx, y), 0).rgb;
            sum = sum + 0.2126 * v.r + 0.7152 * v.g + 0.0722 * v.b;
            count = count + 1.0;
        }
    }
    textureStore(dst, vec2<i32>(x, y), vec4<f32>(sum / count, 0.0, 0.0, 1.0));
}

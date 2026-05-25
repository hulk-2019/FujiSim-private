@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dim = textureDimensions(dst);
    if (gid.x >= dim.x || gid.y >= dim.y) { return; }
    let v = textureLoad(src, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
    textureStore(dst, vec2<i32>(i32(gid.x), i32(gid.y)), v);
}

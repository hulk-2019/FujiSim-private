// Dehaze airlight estimation via GPU reduce.
// Finds the pixel with the highest dark channel value, reads its RGB from src,
// writes result to a storage buffer for CPU readback.
//
// Buffer layout: [best_dark_bits: u32, coord_x: u32, coord_y: u32, _pad: u32,
//                  best_r: u32, best_g: u32, best_b: u32, _pad2: u32]
// best_dark_bits is the bitcast of f32 (positive f32 bit pattern is monotonic).

struct Params { width: u32, height: u32, _pad1: u32, _pad2: u32 };
@group(0) @binding(0) var dark: texture_2d<f32>;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> result: array<atomic<u32>, 8>;
@group(0) @binding(3) var<uniform> p: Params;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= p.width || gid.y >= p.height) { return; }
    let x = i32(gid.x);
    let y = i32(gid.y);
    let d = textureLoad(dark, vec2<i32>(x, y), 0).r;
    let bits = bitcast<u32>(d);

    // atomicCompareExchangeWeak returns a struct { old_value: u32, exchanged: bool }
    var current = atomicLoad(&result[0]);
    loop {
        if (bits <= current) { break; }
        let cmp = atomicCompareExchangeWeak(&result[0], current, bits);
        if (cmp.exchanged) {
            atomicStore(&result[1], u32(x));
            atomicStore(&result[2], u32(y));
            break;
        }
        current = cmp.old_value;
    }
}

// Second dispatch: after all threads have written max dark position,
// read RGB from src at that position.
// We use a separate entry point to avoid race conditions.
@compute @workgroup_size(1, 1, 1)
fn read_rgb(@builtin(global_invocation_id) _gid: vec3<u32>) {
    let cx = atomicLoad(&result[1]);
    let cy = atomicLoad(&result[2]);
    let c = textureLoad(src, vec2<i32>(i32(cx), i32(cy)), 0);
    // Store as bitcast<u32> of f32
    atomicStore(&result[4], bitcast<u32>(c.r));
    atomicStore(&result[5], bitcast<u32>(c.g));
    atomicStore(&result[6], bitcast<u32>(c.b));
}
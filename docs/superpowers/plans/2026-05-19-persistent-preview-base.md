# Persistent 800px Preview Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次 LibRaw 解码同时生成 400px cover JPEG 和 800px 16-bit PNG 预览底图，两者永久写盘并将预览路径存入 SQLite，彻底消除重复解码和缓存上限问题。

**Architecture:** `processing/raw.rs` 新增 `generate_cover_and_preview_base` 函数，一次解码输出 cover JPEG 字节 + 800px 16-bit PNG 字节；`generate_thumbnails` IPC 命令改用该函数并把预览路径写入 `assets.preview_path`；`get_preview` 优先读磁盘预览底图，命中时跳过 LibRaw 解码直接跑色彩流水线。L1 内存缓存和 `preview_cache_dir`（滤镜结果缓存）继续保留作为热缓存。

**Tech Stack:** Rust/Tauri 2, sqlx/SQLite, rsraw (LibRaw bindings), image crate (PNG 16-bit), rayon, tokio

---

## Task 1: DB Migration — 新增 preview_path 列

**Files:**
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/db/assets.rs`

- [ ] **Step 1: 在 `run_migrations` 增量迁移数组末尾追加 ALTER TABLE**

在 `src-tauri/src/db/mod.rs` 的第一个 `for sql in [...]` 增量迁移数组末尾加：

```rust
"ALTER TABLE assets ADD COLUMN preview_path TEXT",
```

- [ ] **Step 2: 在 `Asset` 读模型加 `preview_path` 字段**

在 `src-tauri/src/db/assets.rs` 的 `Asset` 结构体中加：

```rust
pub preview_path: Option<String>,
```

- [ ] **Step 3: 新增 `update_preview_path` 函数**

```rust
pub async fn update_preview_path(
    pool: &SqlitePool,
    id: i64,
    preview_path: &str,
) -> Result<()> {
    sqlx::query("UPDATE assets SET preview_path = ? WHERE id = ?")
        .bind(preview_path)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
```

- [ ] **Step 4: 编译验证**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo check 2>&1 | tail -5
```

Expected: `Finished` 无 error。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/db/assets.rs
git commit -m "feat: add preview_path column to assets, update_preview_path fn"
```

---

## Task 2: AppState 新增 preview_base_dir

**Files:**
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: 新增 `preview_base_dir` 字段**

在 `AppState` 结构体中加：

```rust
pub preview_base_dir: PathBuf,
```

- [ ] **Step 2: 在 `init` 里创建目录并初始化字段**

在 `AppState::init` 里，紧跟 `cover_dir` 的创建逻辑后面加：

```rust
let preview_base_dir = data_dir.join("preview_base");
std::fs::create_dir_all(&preview_base_dir)?;
```

并在 `Arc::new(AppState { ... })` 的字段列表中加：

```rust
preview_base_dir,
```

- [ ] **Step 3: 编译验证**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo check 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/state.rs
git commit -m "feat: add preview_base_dir to AppState"
```

---

## Task 3: 核心函数 `generate_cover_and_preview_base`

**Files:**
- Modify: `src-tauri/src/processing/raw.rs`

这个函数一次 LibRaw 解码，同时输出：
- `cover_jpeg: Vec<u8>`：400px JPEG 字节（用于网格缩略图）
- `preview_png: Vec<u8>`：800px 16-bit PNG 字节（用于预览底图永久缓存）

- [ ] **Step 1: 新增函数**

在 `src-tauri/src/processing/raw.rs` 末尾追加：

```rust
/// 一次 LibRaw 解码，同时生成 400px cover JPEG 和 800px 16-bit PNG 预览底图。
/// cover 用于网格缩略图快速显示；preview_base 用于永久磁盘缓存，避免重复 RAW 解码。
pub fn generate_cover_and_preview_base(
    path: &Path,
) -> Result<(Vec<u8>, Vec<u8>)> {
    let data = std::fs::read(path)?;
    let orientation = read_tiff_file_orientation(&data).unwrap_or(1);

    // LibRaw 解码，half_size=false 保证 800px 底图质量
    let rgb16 = decode_raw_rgb16_from_bytes(&data, None)?;
    let rgb16 = apply_orientation_rgb16(rgb16, orientation);

    let (w, h) = rgb16.dimensions();

    // ── cover 400px JPEG ─────────────────────────────────────────────────────
    let cover_scale = (400f32 / w.max(h) as f32).min(1.0);
    let cover_w = ((w as f32 * cover_scale).round() as u32).max(1);
    let cover_h = ((h as f32 * cover_scale).round() as u32).max(1);
    let cover_16 = image::imageops::resize(&rgb16, cover_w, cover_h, image::imageops::FilterType::Triangle);
    let mut cover_rgb8 = image::RgbImage::new(cover_w, cover_h);
    for (x, y, px) in cover_16.enumerate_pixels() {
        cover_rgb8.put_pixel(x, y, image::Rgb([
            (px.0[0] >> 8) as u8,
            (px.0[1] >> 8) as u8,
            (px.0[2] >> 8) as u8,
        ]));
    }
    let mut cover_buf = std::io::Cursor::new(Vec::new());
    cover_rgb8
        .write_to(&mut cover_buf, image::ImageFormat::Jpeg)
        .map_err(|e| AppError::other(format!("cover encode: {e}")))?;
    let cover_jpeg = cover_buf.into_inner();

    // ── preview_base 800px 16-bit PNG ────────────────────────────────────────
    let prev_scale = (800f32 / w.max(h) as f32).min(1.0);
    let prev_w = ((w as f32 * prev_scale).round() as u32).max(1);
    let prev_h = ((h as f32 * prev_scale).round() as u32).max(1);
    let preview_16 = if prev_scale < 1.0 {
        image::imageops::resize(&rgb16, prev_w, prev_h, image::imageops::FilterType::Triangle)
    } else {
        rgb16
    };
    let mut preview_buf = std::io::Cursor::new(Vec::new());
    preview_16
        .write_to(&mut preview_buf, image::ImageFormat::Png)
        .map_err(|e| AppError::other(format!("preview_base encode: {e}")))?;
    let preview_png = preview_buf.into_inner();

    Ok((cover_jpeg, preview_png))
}
```

- [ ] **Step 2: 编译验证**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo check 2>&1 | tail -5
```

Expected: `Finished` 无 error。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/processing/raw.rs
git commit -m "feat: generate_cover_and_preview_base — single LibRaw decode outputs 400px cover + 800px 16-bit PNG"
```

---

## Task 4: 改造 `generate_thumbnails` — 一次解码写两个文件

**Files:**
- Modify: `src-tauri/src/ipc.rs`

`generate_thumbnails` 目前调用 `extract_cover_fast`（提取嵌入 JPEG）。改为调用 `generate_cover_and_preview_base`，同时写 cover 和 preview_base，并把 preview_base 路径更新到 SQLite。

- [ ] **Step 1: 找到 `generate_thumbnails` 里 `extract_cover_fast` 的调用，替换为新函数**

找到 `ipc.rs` 中 `generate_thumbnails` 函数里如下代码段：

```rust
let src = std::path::PathBuf::from(&asset.file_path);
let cover_jpeg = match processing::raw::extract_cover_fast(&src, 400) {
    Ok(c) => c,
    Err(e) => {
        tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: cover extract failed");
        return;
    }
};

if let Err(e) = std::fs::write(&cover_path, &cover_jpeg) {
    tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: write cover failed");
    return;
}

let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
```

替换为：

```rust
let src = std::path::PathBuf::from(&asset.file_path);
let (cover_jpeg, preview_png) = match processing::raw::generate_cover_and_preview_base(&src) {
    Ok(pair) => pair,
    Err(e) => {
        tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: decode failed");
        return;
    }
};

if let Err(e) = std::fs::write(&cover_path, &cover_jpeg) {
    tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: write cover failed");
    return;
}

// 写 800px 16-bit PNG 预览底图
let preview_path = preview_base_dir.join(format!("{}_{}.png", asset.id, mtime));
if let Err(e) = std::fs::write(&preview_path, &preview_png) {
    tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: write preview_base failed");
} else {
    let preview_path_str = preview_path.to_string_lossy().to_string();
    let _ = rt.block_on(crate::db::assets::update_preview_path(&pool, asset.id, &preview_path_str));
}

let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
```

- [ ] **Step 2: 把 `preview_base_dir` 和 `pool` 克隆到闭包**

在 `generate_thumbnails` 函数中，找到 `let cover_dir = state.cover_dir.clone();` 这行，紧接着追加：

```rust
let preview_base_dir = state.preview_base_dir.clone();
let pool = state.pool.clone();
```

然后在 `spawn_blocking` 闭包开头的变量捕获处，确保 `preview_base_dir` 和 `pool` 被 move 进去（检查编译错误提示，根据需要调整 clone 位置）。

在闭包内 `let _permit = permit;` 之后，需要有 `let rt = tokio::runtime::Handle::current();` 供 `block_on` 调用——检查该闭包内是否已有此行，没有则加上：

```rust
let rt = tokio::runtime::Handle::current();
```

- [ ] **Step 3: 编译验证**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo check 2>&1 | tail -10
```

Expected: `Finished` 无 error。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ipc.rs
git commit -m "feat: generate_thumbnails writes 800px preview_base PNG + updates assets.preview_path"
```

---

## Task 5: `get_preview` 优先读磁盘预览底图

**Files:**
- Modify: `src-tauri/src/ipc.rs`

当 `asset.preview_path` 非空且文件存在时，直接 `image::open` 读 PNG，跳过 LibRaw 解码，把读到的图存入 L1 内存缓存后走色彩流水线。

- [ ] **Step 1: 在 `get_preview` 的 L1 内存缓存命中检查之后、`preview_sem` acquire 之前，插入磁盘预览底图路径命中逻辑**

找到 `get_preview` 中如下代码：

```rust
    // 未命中：在 async 上下文 acquire permit，排队等待而非降级，
```

在该行**之前**插入：

```rust
    // L2：磁盘预览底图（800px 16-bit PNG），命中时跳过 LibRaw 解码
    if let Some(ref pp) = asset.preview_path {
        let pp_path = PathBuf::from(pp);
        if pp_path.exists() {
            let cache = state.preview_cache.clone();
            let preview_pool = state.preview_pool.clone();
            let pcd = preview_cache_dir.clone();
            return tokio::task::spawn_blocking(move || {
                preview_pool.install(|| {
                    let img = image::open(&pp_path)
                        .map_err(|e| AppError::other(format!("preview_base read: {e}")))?
                        .to_rgb16();
                    let resized = Arc::new(img);
                    if let Ok(mut c) = cache.lock() {
                        while c.len() >= 20 {
                            c.shift_remove_index(0);
                        }
                        c.insert((asset_id, max_edge), resized.clone());
                    }
                    render_preview_from_cache(&resized, &settings, lut.as_deref(), &pcd, asset_id)
                })
            })
            .await
            .map_err(|e| AppError::other(e.to_string()))?;
        }
    }

```

- [ ] **Step 2: 编译验证**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo check 2>&1 | tail -10
```

Expected: `Finished` 无 error。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/ipc.rs
git commit -m "perf: get_preview reads 800px PNG preview_base from disk, skips LibRaw decode on cache hit"
```

---

## Task 6: 前端 types.ts 同步 preview_path 字段

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: 在 `Asset` 类型中新增 `preview_path` 字段**

```typescript
preview_path: string | null;
```

- [ ] **Step 2: TypeScript 编译验证**

```bash
pnpm tsc --noEmit 2>&1 | tail -5
```

Expected: 无输出（无 error）。

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add preview_path to Asset type"
```

---

## Self-Review

1. **Spec 覆盖**：一次解码 ✓（Task 3）、cover 写盘 ✓（Task 4）、preview_base 写盘 ✓（Task 4）、路径存 SQLite ✓（Task 1+4）、`get_preview` 优先读磁盘 ✓（Task 5）、前端类型同步 ✓（Task 6）

2. **Placeholder 扫描**：无 TBD/TODO，所有代码块完整

3. **类型一致性**：
   - `update_preview_path(pool, id, &str)` 在 Task 1 定义，Task 4 调用 ✓
   - `generate_cover_and_preview_base(path) -> Result<(Vec<u8>, Vec<u8>)>` 在 Task 3 定义，Task 4 调用 ✓
   - `preview_base_dir: PathBuf` 在 Task 2 定义，Task 4 使用 ✓
   - `asset.preview_path: Option<String>` 在 Task 1 加到 `Asset`，Task 5 读取 ✓

4. **依赖顺序**：Task 1（DB）→ Task 2（state）→ Task 3（raw fn）→ Task 4（ipc 写盘）→ Task 5（ipc 读盘）→ Task 6（前端）

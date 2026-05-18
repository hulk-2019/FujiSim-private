# RAW 封面图与预览图磁盘缓存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 RAW/DNG 资产生成 400px 封面图（AssetGrid 用）和原图预览图（PreviewPanel 用），路径持久化到 assets 表，避免重复解析，前端改用文件协议加载消除 base64 开销。

**Architecture:** 扩展现有 `generate_thumbnails` 命令，在提取嵌入 JPEG 后同步生成 400px 封面图，两个路径写入 DB。前端 AssetGrid 优先用 `cover_path`，PreviewPanel 优先用 `thumbnail_path` 通过 `convertFileSrc` 直接加载文件，均降级兼容旧数据。

**Tech Stack:** Rust / sqlx / image 0.25 / Tauri / React / TypeScript

---

### Task 1: DB 迁移 + Rust 数据层

**Files:**
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/db/assets.rs`
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: 在 `db/mod.rs` 的增量迁移列表中追加两条 ALTER TABLE**

在 `run_migrations` 函数的第一个 `for sql in [...]` 块末尾追加（与现有条目格式完全一致）：

```rust
"ALTER TABLE assets ADD COLUMN thumbnail_path TEXT",
"ALTER TABLE assets ADD COLUMN cover_path TEXT",
```

完整的 for 块变为：
```rust
for sql in [
    "ALTER TABLE batch_tasks ADD COLUMN asset_ids_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE batch_tasks ADD COLUMN watermark_json TEXT",
    "ALTER TABLE batch_tasks ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE batch_tasks ADD COLUMN deleted_at TEXT",
    "ALTER TABLE user_luts ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE user_luts ADD COLUMN deleted_at TEXT",
    "ALTER TABLE watermark_presets ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE watermark_presets ADD COLUMN deleted_at TEXT",
    "ALTER TABLE assets ADD COLUMN thumbnail_path TEXT",
    "ALTER TABLE assets ADD COLUMN cover_path TEXT",
] {
    let _ = sqlx::query(sql).execute(pool).await;
}
```

- [ ] **Step 2: 在 `Asset` struct 中新增两个字段**

在 `src-tauri/src/db/assets.rs` 的 `Asset` struct 末尾（`created_at` 字段之后）追加：

```rust
pub thumbnail_path: Option<String>,
pub cover_path: Option<String>,
```

- [ ] **Step 3: 在 `NewAsset` struct 中新增两个字段**

在 `NewAsset` struct 末尾（`is_raw` 字段之后）追加：

```rust
pub thumbnail_path: Option<String>,
pub cover_path: Option<String>,
```

- [ ] **Step 4: 在 `insert_many` 中补充新字段**

`insert_many` 的 INSERT SQL 和 bind 链需要包含新字段。将 INSERT 语句改为：

```rust
let res = sqlx::query(
    r#"INSERT INTO assets (file_path,file_name,file_type,file_size,date_taken,camera_make,camera_model,lens_model,iso,f_number,shutter_speed,focal_length,width,height,is_raw,thumbnail_path,cover_path)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(file_path) DO UPDATE SET
         file_name = excluded.file_name,
         file_type = excluded.file_type,
         file_size = excluded.file_size,
         date_taken = excluded.date_taken,
         camera_make = excluded.camera_make,
         camera_model = excluded.camera_model,
         lens_model = excluded.lens_model,
         iso = excluded.iso,
         f_number = excluded.f_number,
         shutter_speed = excluded.shutter_speed,
         focal_length = excluded.focal_length,
         width = excluded.width,
         height = excluded.height,
         is_raw = excluded.is_raw"#,
)
.bind(&a.file_path)
.bind(&a.file_name)
.bind(&a.file_type)
.bind(a.file_size)
.bind(&a.date_taken)
.bind(&a.camera_make)
.bind(&a.camera_model)
.bind(&a.lens_model)
.bind(a.iso)
.bind(a.f_number)
.bind(&a.shutter_speed)
.bind(a.focal_length)
.bind(a.width)
.bind(a.height)
.bind(a.is_raw as i64)
.bind(&a.thumbnail_path)
.bind(&a.cover_path)
.execute(&mut *tx)
.await?;
```

注意：ON CONFLICT 故意不更新 `thumbnail_path`/`cover_path`，保留已生成的缓存。

- [ ] **Step 5: 新增 `update_thumbnail_paths` 函数**

在 `src-tauri/src/db/assets.rs` 末尾（`_placeholder_time` 函数之前）追加：

```rust
pub async fn update_thumbnail_paths(
    pool: &SqlitePool,
    id: i64,
    thumbnail_path: &str,
    cover_path: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE assets SET thumbnail_path = ?, cover_path = ? WHERE id = ?",
    )
    .bind(thumbnail_path)
    .bind(cover_path)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}
```

- [ ] **Step 6: 在 `scanner.rs` 的 `build_asset` 中补充新字段**

`build_asset` 返回的 `NewAsset` 需要包含新字段（导入时均为 None）：

```rust
fn build_asset(...) -> NewAsset {
    NewAsset {
        file_path: path.to_string_lossy().to_string(),
        file_name,
        file_type,
        file_size,
        date_taken: exif.date_taken,
        camera_make: exif.camera_make,
        camera_model: exif.camera_model,
        lens_model: exif.lens_model,
        iso: exif.iso,
        f_number: exif.f_number,
        shutter_speed: exif.shutter_speed,
        focal_length: exif.focal_length,
        width,
        height,
        is_raw: matches!(kind, FileKind::Raw),
        thumbnail_path: None,
        cover_path: None,
    }
}
```

- [ ] **Step 7: 在 `state.rs` 中新增 `cover_dir`**

在 `AppState` struct 中 `watermark_dir` 字段之后追加：

```rust
pub cover_dir: PathBuf,
```

在 `AppState::init()` 中，`watermark_dir` 初始化之后追加：

```rust
let cover_dir = data_dir.join("covers");
std::fs::create_dir_all(&cover_dir)?;
```

在 `Arc::new(AppState { ... })` 的字段列表中追加：

```rust
cover_dir,
```

- [ ] **Step 8: 编译验证**

```bash
cd src-tauri && cargo build 2>&1 | tail -20
```

期望：编译成功，无 error。

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/db/assets.rs src-tauri/src/asset/scanner.rs src-tauri/src/state.rs
git commit -m "feat: add thumbnail_path/cover_path to assets table and state"
```

---

### Task 2: `resize_jpeg_to_cover` 纯函数

**Files:**
- Modify: `src-tauri/src/processing/raw.rs`

- [ ] **Step 1: 在 `processing/raw.rs` 末尾追加函数**

在文件最后（`Tiff` impl 块之后）追加：

```rust
/// 把 JPEG 字节缩放到指定长边（等比例），重新编码为 JPEG 返回。
/// 若原图长边已 <= max_edge，原样返回（不放大）。
pub fn resize_jpeg_to_cover(jpeg: &[u8], max_edge: u32) -> Result<Vec<u8>> {
    let img = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg)
        .map_err(|e| AppError::other(format!("cover decode: {e}")))?;

    let (w, h) = (img.width(), img.height());
    let long_edge = w.max(h);

    let resized = if long_edge > max_edge {
        let scale = max_edge as f32 / long_edge as f32;
        let nw = ((w as f32 * scale).round() as u32).max(1);
        let nh = ((h as f32 * scale).round() as u32).max(1);
        img.resize(nw, nh, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    let mut buf = std::io::Cursor::new(Vec::new());
    resized
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .map_err(|e| AppError::other(format!("cover encode: {e}")))?;
    Ok(buf.into_inner())
}
```

- [ ] **Step 2: 编译验证**

```bash
cd src-tauri && cargo build 2>&1 | tail -10
```

期望：编译成功。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/processing/raw.rs
git commit -m "feat: add resize_jpeg_to_cover helper"
```

---

### Task 3: 扩展 `generate_thumbnails` 命令

**Files:**
- Modify: `src-tauri/src/ipc.rs`

- [ ] **Step 1: 找到 `generate_thumbnails` 中的 `spawn_blocking` 闭包**

当前闭包（约 1255-1275 行）逻辑为：检查缓存 → 提取 JPEG → 写盘 → emit。

将整个闭包替换为以下内容：

```rust
handles.push(tokio::task::spawn_blocking(move || {
    let _permit = permit;
    let thumbnail_path = thumbnail_dir.join(format!("{}.jpg", asset.id));
    let cover_path = cover_dir.join(format!("{}.jpg", asset.id));

    // 幂等：两个文件都存在且 DB 路径已记录则跳过
    if asset.thumbnail_path.is_some()
        && asset.cover_path.is_some()
        && thumbnail_path.exists()
        && cover_path.exists()
    {
        let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
        return;
    }

    let src = std::path::PathBuf::from(&asset.file_path);
    let jpeg = match processing::raw::extract_raw_thumbnail(&src) {
        Ok(j) => j,
        Err(e) => {
            tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: extract failed");
            return;
        }
    };

    // 写预览图
    if let Err(e) = std::fs::write(&thumbnail_path, &jpeg) {
        tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: write thumbnail failed");
        return;
    }

    // 生成并写封面图
    let cover_jpeg = match processing::raw::resize_jpeg_to_cover(&jpeg, 400) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: cover resize failed");
            // 封面失败不阻断预览图，仍更新 thumbnail_path
            let tp = thumbnail_path.to_string_lossy().to_string();
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let _ = handle.block_on(db::assets::update_thumbnail_paths_partial(&pool_ref, asset.id, &tp));
            }
            let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
            return;
        }
    };

    if let Err(e) = std::fs::write(&cover_path, &cover_jpeg) {
        tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: write cover failed");
        return;
    }

    // 两个路径都写成功，更新 DB
    let tp = thumbnail_path.to_string_lossy().to_string();
    let cp = cover_path.to_string_lossy().to_string();
    // spawn_blocking 内无法直接 .await，用 tokio Handle 执行异步
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let _ = handle.block_on(db::assets::update_thumbnail_paths(&pool_ref, asset.id, &tp, &cp));
    }

    let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
}));
```

- [ ] **Step 2: 在闭包外捕获 `cover_dir` 和 `pool_ref`**

在 `generate_thumbnails` 函数中，`thumbnail_dir` 克隆之后追加：

```rust
let cover_dir = state.cover_dir.clone();
let pool_ref = state.pool.clone();
```

在 `for asset in raw_assets` 循环内，`thumbnail_dir` 克隆之后追加：

```rust
let cover_dir = cover_dir.clone();
let pool_ref = pool_ref.clone();
```

- [ ] **Step 3: 在 `db/assets.rs` 新增 `update_thumbnail_paths_partial`（仅更新 thumbnail_path）**

```rust
pub async fn update_thumbnail_paths_partial(
    pool: &SqlitePool,
    id: i64,
    thumbnail_path: &str,
) -> Result<()> {
    sqlx::query("UPDATE assets SET thumbnail_path = ? WHERE id = ?")
        .bind(thumbnail_path)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
```

- [ ] **Step 4: 在 `clear_all_data` 中清空 `covers/` 目录并置 NULL**

在 `clear_all_data` 函数中，thumbnails 清空逻辑之后追加：

```rust
// covers 目录整体清空
if state.cover_dir.exists() {
    let _ = std::fs::remove_dir_all(&state.cover_dir);
    let _ = std::fs::create_dir_all(&state.cover_dir);
}
// 清空 DB 中的路径字段
let _ = sqlx::query("UPDATE assets SET thumbnail_path = NULL, cover_path = NULL")
    .execute(&state.pool)
    .await;
```

- [ ] **Step 5: 编译验证**

```bash
cd src-tauri && cargo build 2>&1 | tail -20
```

期望：编译成功，无 error。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/db/assets.rs
git commit -m "feat: generate cover (400px) alongside thumbnail in generate_thumbnails"
```

---

### Task 4: 前端类型 + AssetGrid

**Files:**
- Modify: `src/types.ts`
- Modify: `src/components/AssetGrid.tsx`

- [ ] **Step 1: 在 `src/types.ts` 的 `Asset` 类型末尾追加两个字段**

在 `created_at: string;` 之后追加：

```ts
thumbnail_path?: string | null;
cover_path?: string | null;
```

- [ ] **Step 2: 修改 `AssetGrid.tsx` 中的 `src` 计算逻辑**

找到 `AssetCard` 组件内的 `useMemo`（约第 354-362 行）：

```ts
const src = useMemo(() => {
  if (!asset.is_raw) {
    try { return convertFileSrc(asset.file_path); } catch { return null; }
  }
  if (isThumbReady && thumbnailDir) {
    try { return convertFileSrc(`${thumbnailDir}/${asset.id}.jpg`); } catch { return null; }
  }
  return null;
}, [asset.file_path, asset.is_raw, asset.id, isThumbReady, thumbnailDir]);
```

替换为：

```ts
const src = useMemo(() => {
  if (!asset.is_raw) {
    try { return convertFileSrc(asset.file_path); } catch { return null; }
  }
  // 优先用持久化的封面图路径
  if (asset.cover_path) {
    try { return convertFileSrc(asset.cover_path); } catch { return null; }
  }
  // 降级：兼容旧数据（cover_path 为 null 时）
  if (isThumbReady && thumbnailDir) {
    try { return convertFileSrc(`${thumbnailDir}/${asset.id}.jpg`); } catch { return null; }
  }
  return null;
}, [asset.file_path, asset.is_raw, asset.id, asset.cover_path, isThumbReady, thumbnailDir]);
```

- [ ] **Step 3: Commit**

```bash
git add src/types.ts src/components/AssetGrid.tsx
git commit -m "feat: AssetGrid uses cover_path for RAW thumbnails"
```

---

### Task 5: PreviewPanel 改用文件协议

**Files:**
- Modify: `src/components/PreviewPanel.tsx`

- [ ] **Step 1: 找到 Phase 1 的 thumbSrc 设置逻辑（约第 68-90 行）**

当前逻辑：

```ts
useEffect(() => {
  if (!focused) {
    setThumbSrc(null);
    return;
  }
  if (focused.is_raw) {
    if (rawThumbnailReady.has(focused.id) && thumbnailDir) {
      try {
        setThumbSrc(convertFileSrc(`${thumbnailDir}/${focused.id}.jpg`));
      } catch {
        setThumbSrc(null);
      }
    } else {
      setThumbSrc(null);
    }
  } else {
    try {
      setThumbSrc(convertFileSrc(focused.file_path));
    } catch {
      setThumbSrc(null);
    }
  }
}, [focused?.id, focused?.file_path, focused?.is_raw, rawThumbnailReady, thumbnailDir]);
```

替换为：

```ts
useEffect(() => {
  if (!focused) {
    setThumbSrc(null);
    return;
  }
  if (focused.is_raw) {
    // 优先用持久化的 thumbnail_path（文件协议，零 base64 开销）
    if (focused.thumbnail_path) {
      try {
        setThumbSrc(convertFileSrc(focused.thumbnail_path));
      } catch {
        setThumbSrc(null);
      }
    } else if (rawThumbnailReady.has(focused.id) && thumbnailDir) {
      // 降级：兼容旧数据
      try {
        setThumbSrc(convertFileSrc(`${thumbnailDir}/${focused.id}.jpg`));
      } catch {
        setThumbSrc(null);
      }
    } else {
      setThumbSrc(null);
    }
  } else {
    try {
      setThumbSrc(convertFileSrc(focused.file_path));
    } catch {
      setThumbSrc(null);
    }
  }
}, [focused?.id, focused?.file_path, focused?.is_raw, focused?.thumbnail_path, rawThumbnailReady, thumbnailDir]);
```

- [ ] **Step 2: Commit**

```bash
git add src/components/PreviewPanel.tsx
git commit -m "feat: PreviewPanel uses thumbnail_path file protocol instead of base64"
```

---

### Task 6: 端到端验证

- [ ] **Step 1: 启动开发服务**

```bash
pnpm tauri dev
```

- [ ] **Step 2: 导入包含 RAW/DNG 文件的目录**

在应用中点击导入，选择含 RAW 文件的目录，确认导入成功。

- [ ] **Step 3: 触发缩略图生成**

应用会自动调用 `generate_thumbnails`。等待 `thumbnail:all_done` 事件（控制台或 UI 状态变化）。

- [ ] **Step 4: 验证 AssetGrid**

- RAW 资产的网格缩略图应正常显示
- 检查 `~/Library/Application Support/FujiSim/covers/` 目录，确认有 `{id}.jpg` 文件
- 文件大小应明显小于 `thumbnails/` 下对应文件（400px vs 原始分辨率）

- [ ] **Step 5: 验证 PreviewPanel**

- 点击 RAW 资产，PreviewPanel 应立即显示预览图（无需等待 base64 IPC）
- 检查 `~/Library/Application Support/FujiSim/thumbnails/` 目录，确认文件存在

- [ ] **Step 6: 验证 DB 路径字段**

```bash
sqlite3 ~/Library/Application\ Support/FujiSim/library.db \
  "SELECT id, thumbnail_path, cover_path FROM assets WHERE is_raw=1 LIMIT 5;"
```

期望：`thumbnail_path` 和 `cover_path` 均非 NULL，路径指向实际存在的文件。

- [ ] **Step 7: 验证幂等性**

再次触发 `generate_thumbnails`（重新导入同一目录），确认已有缓存的资产被跳过（不重新生成文件）。

- [ ] **Step 8: 验证清除缓存**

在设置中点击"清除缓存"，确认：
- `covers/` 目录被清空
- `thumbnails/` 目录被清空
- DB 中 `thumbnail_path`/`cover_path` 均变为 NULL

- [ ] **Step 9: Final commit**

```bash
git add -A
git commit -m "feat: RAW cover/thumbnail disk cache complete"
```

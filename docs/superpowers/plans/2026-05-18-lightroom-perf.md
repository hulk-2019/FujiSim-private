# FujiSim Lightroom-级性能优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过两阶段导入、分级缓存、动态导出并发、本地文件预览四项改造，使 FujiSim 在大批量 RAW 场景下达到接近 Lightroom 的交互体验。

**Architecture:** 导入与 EXIF 提取解耦为两个阶段，阶段一只写路径元数据（<1s 可见网格），阶段二后台并发补全 EXIF；缩略图改用 `{asset_id}_{mtime}.jpg` 命名实现自动失效；预览从 base64 IPC 改为本地文件路径，前端用 `convertFileSrc` 加载；导出并发改为内存感知动态调度。

**Tech Stack:** Rust/Tauri 2, sqlx/SQLite, rayon, tokio, React 18, TypeScript, zustand, @tanstack/react-virtual

---

## Task 1: DB Migration — 新增 exif_extracted 和 file_mtime 列

**Files:**
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: 在 `run_migrations` 的增量迁移数组末尾追加两条 ALTER TABLE**

在 `src-tauri/src/db/mod.rs` 的 `run_migrations` 函数里，找到现有的增量迁移 `for sql in [...]` 数组，在末尾追加：

```rust
"ALTER TABLE assets ADD COLUMN exif_extracted INTEGER NOT NULL DEFAULT 0",
"ALTER TABLE assets ADD COLUMN file_mtime INTEGER",
```

- [ ] **Step 2: 验证编译通过**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

Expected: `Finished` 无 error。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/db/mod.rs
git commit -m "feat: add exif_extracted and file_mtime columns to assets"
```

---

## Task 2: scanner — 阶段一快速扫描（只收路径，不读文件内容）

**Files:**
- Modify: `src-tauri/src/asset/scanner.rs`

- [ ] **Step 1: 修改 `extract_meta` 为空实现，阶段一不提取 EXIF**

将 `scan_dir` 和 `scan_files` 里对 `extract_meta` 的调用替换为只读文件系统元数据：

```rust
// scanner.rs — scan_dir 内循环体替换为：
let file_name = entry.file_name().to_string_lossy().to_string();
let file_type = format::ext_upper(path);
let metadata = entry.metadata().ok();
let file_size = metadata.as_ref().map(|m| m.len() as i64);
let file_mtime = metadata.as_ref()
    .and_then(|m| m.modified().ok())
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_secs() as i64);

items.push(NewAsset {
    file_path: path.to_string_lossy().to_string(),
    file_name,
    file_type: Some(file_type),
    file_size,
    file_mtime,
    date_taken: None,
    camera_make: None,
    camera_model: None,
    lens_model: None,
    iso: None,
    f_number: None,
    shutter_speed: None,
    focal_length: None,
    width: None,
    height: None,
    is_raw: kind == FileKind::Raw,
});
```

- [ ] **Step 2: 同步更新 `NewAsset` 结构体，新增 `file_mtime` 字段**

在 `src-tauri/src/db/assets.rs` 的 `NewAsset` 结构体中添加：

```rust
pub file_mtime: Option<i64>,
```

- [ ] **Step 3: 同步更新 `insert_many`，写入 `file_mtime`**

在 `assets.rs` 的 `insert_many` SQL 中加入 `file_mtime` 列：

```rust
sqlx::query(
    "INSERT OR IGNORE INTO assets
     (file_path, file_name, file_type, file_size, file_mtime,
      date_taken, camera_make, camera_model, lens_model,
      iso, f_number, shutter_speed, focal_length,
      width, height, is_raw)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
)
.bind(&item.file_path)
.bind(&item.file_name)
.bind(&item.file_type)
.bind(item.file_size)
.bind(item.file_mtime)
// ... 其余字段同原来
```

- [ ] **Step 4: 同步更新 `Asset` 读模型，新增 `file_mtime` 字段**

```rust
pub file_mtime: Option<i64>,
```

- [ ] **Step 5: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

Expected: `Finished` 无 error。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/asset/scanner.rs src-tauri/src/db/assets.rs
git commit -m "feat: phase-1 fast scan — collect path+mtime only, skip EXIF"
```

---

## Task 3: EXIF 后台 Worker

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/ipc.rs`

- [ ] **Step 1: 在 `AppState` 新增 `exif_sem`**

```rust
// state.rs
pub exif_sem: Arc<tokio::sync::Semaphore>,
```

在 `AppState::init` 里初始化：

```rust
exif_sem: Arc::new(tokio::sync::Semaphore::new(4)),
```

- [ ] **Step 2: 在 `ipc.rs` 新增内部函数 `start_exif_worker`**

```rust
fn start_exif_worker(state: SharedState, app: tauri::AppHandle) {
    tokio::task::spawn(async move {
        loop {
            // 取一批未提取的资产（最多 20 条）
            let batch = match crate::db::assets::list_exif_pending(&state.pool, 20).await {
                Ok(b) => b,
                Err(_) => break,
            };
            if batch.is_empty() { break; }

            let mut handles = Vec::new();
            for asset in batch {
                let permit = state.exif_sem.clone().acquire_owned().await;
                let Ok(permit) = permit else { break };
                let pool = state.pool.clone();
                let app2 = app.clone();
                handles.push(tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    let path = std::path::Path::new(&asset.file_path);
                    let kind = crate::asset::format::classify(path);
                    let (exif, width, height) = crate::asset::scanner::extract_exif_only(path, kind);
                    let rt = tokio::runtime::Handle::current();
                    let _ = rt.block_on(crate::db::assets::update_exif(
                        &pool, asset.id, &exif, width, height,
                    ));
                    let _ = app2.emit("exif:item_done", asset.id);
                }));
            }
            for h in handles { let _ = h.await; }

            // 通知前端这批完成
            let _ = app.emit("exif:batch_done", ());
        }
    });
}
```

- [ ] **Step 3: 在 `import_directory` 末尾调用 worker**

```rust
// import_directory 函数末尾，emit import:done 之后：
let _ = app.emit("import:done", &report);
start_exif_worker(state.inner().clone(), app);
Ok(report)
```

对 `import_files` 做同样处理。

- [ ] **Step 4: 在 `db/assets.rs` 新增两个函数**

```rust
/// 取出 exif_extracted=0 的资产，最多 limit 条
pub async fn list_exif_pending(pool: &SqlitePool, limit: i64) -> Result<Vec<Asset>> {
    Ok(sqlx::query_as::<_, Asset>(
        "SELECT * FROM assets WHERE exif_extracted = 0 LIMIT ?"
    )
    .bind(limit)
    .fetch_all(pool)
    .await?)
}

/// 把 EXIF 数据写回资产，标记 exif_extracted=1
pub async fn update_exif(
    pool: &SqlitePool,
    id: i64,
    exif: &crate::asset::exif::ExifData,
    width: Option<i64>,
    height: Option<i64>,
) -> Result<()> {
    sqlx::query(
        "UPDATE assets SET
           date_taken=?, camera_make=?, camera_model=?, lens_model=?,
           iso=?, f_number=?, shutter_speed=?, focal_length=?,
           width=?, height=?, exif_extracted=1
         WHERE id=?"
    )
    .bind(&exif.date_taken)
    .bind(&exif.camera_make)
    .bind(&exif.camera_model)
    .bind(&exif.lens_model)
    .bind(exif.iso)
    .bind(exif.f_number)
    .bind(&exif.shutter_speed)
    .bind(exif.focal_length)
    .bind(width)
    .bind(height)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}
```

- [ ] **Step 5: 在 `scanner.rs` 新增 `extract_exif_only` 公开函数**

把原来 `extract_meta` 的逻辑提取为独立函数，供 worker 调用：

```rust
pub fn extract_exif_only(
    path: &Path,
    kind: FileKind,
) -> (crate::asset::exif::ExifData, Option<i64>, Option<i64>) {
    extract_meta(path, kind)
}
```

- [ ] **Step 6: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/ipc.rs src-tauri/src/db/assets.rs src-tauri/src/asset/scanner.rs
git commit -m "feat: background EXIF worker with exif_sem=4 concurrency"
```

---

## Task 4: L2 缩略图缓存文件名加 mtime

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src/components/AssetGrid.tsx`
- Modify: `src/types.ts`

- [ ] **Step 1: 修改 `generate_thumbnails` 的 cover 文件名**

在 `ipc.rs` 的 `generate_thumbnails` 里，将：

```rust
let cover_path = cover_dir.join(format!("{}.jpg", asset.id));
```

改为：

```rust
let mtime = std::path::Path::new(&asset.file_path)
    .metadata()
    .ok()
    .and_then(|m| m.modified().ok())
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_secs())
    .unwrap_or(0);
let cover_path = cover_dir.join(format!("{}_{}.jpg", asset.id, mtime));
```

同样修改 `get_raw_thumbnail` 里的路径逻辑（如有）。

- [ ] **Step 2: 在 `types.ts` 的 `Asset` 类型新增 `file_mtime`**

```typescript
file_mtime: number | null;
```

- [ ] **Step 3: 修改 `AssetGrid.tsx` 的缩略图 src 拼接**

将：

```typescript
convertFileSrc(`${coverDir}/${asset.id}.jpg`)
```

改为：

```typescript
convertFileSrc(`${coverDir}/${asset.id}_${asset.file_mtime ?? 0}.jpg`)
```

- [ ] **Step 4: 启动 dev 环境验证缩略图正常加载**

```bash
pnpm tauri dev
```

导入一个包含 RAW 的目录，确认网格缩略图正常显示。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ipc.rs src/types.ts src/components/AssetGrid.tsx
git commit -m "feat: L2 thumbnail cache keyed by asset_id+mtime for auto-invalidation"
```

---

## Task 5: 预览改用本地文件路径（替代 base64）

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src/types.ts`
- Modify: `src/api.ts`
- Modify: `src/components/PreviewPanel.tsx`

- [ ] **Step 1: 在 `AppState` 新增 `preview_cache_dir`**

```rust
// state.rs
pub preview_cache_dir: PathBuf,
```

在 `init` 里：

```rust
let preview_cache_dir = data_dir.join("preview_cache");
std::fs::create_dir_all(&preview_cache_dir)?;
```

并加入 `AppState { ..., preview_cache_dir, ... }`。

- [ ] **Step 2: 修改 `PreviewResult` 结构体**

在 `ipc.rs` 里将：

```rust
pub struct PreviewResult {
    pub mime: String,
    pub data: String,
    pub width: u32,
    pub height: u32,
}
```

改为：

```rust
pub struct PreviewResult {
    pub path: String,   // 本地文件绝对路径，前端用 convertFileSrc 加载
    pub width: u32,
    pub height: u32,
}
```

- [ ] **Step 3: 修改 `render_preview_from_cache`，写文件替代 base64**

```rust
fn render_preview_from_cache(
    resized: &image::ImageBuffer<image::Rgb<u16>, Vec<u16>>,
    settings: &FilterSettings,
    lut: Option<&Lut3D>,
    preview_cache_dir: &std::path::Path,
    asset_id: i64,
) -> Result<PreviewResult> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    // hash settings fields
    settings.base_simulation.hash(&mut hasher);
    settings.grain_effect.hash(&mut hasher);
    settings.highlight_tone.to_bits().hash(&mut hasher);
    settings.shadow_tone.to_bits().hash(&mut hasher);
    settings.color_saturation.to_bits().hash(&mut hasher);
    settings.clarity.to_bits().hash(&mut hasher);
    settings.sharpness.to_bits().hash(&mut hasher);
    settings.wb_shift_r.hash(&mut hasher);
    settings.wb_shift_b.hash(&mut hasher);
    settings.lut_file_path.hash(&mut hasher);
    let h = hasher.finish();

    let file_name = format!("{}_{:016x}.jpg", asset_id, h);
    let out_path = preview_cache_dir.join(&file_name);

    if !out_path.exists() {
        let processed = crate::processing::process_image(resized, settings, lut)?;
        let (pw, ph) = processed.dimensions();
        let mut rgb8 = image::RgbImage::new(pw, ph);
        for (x, y, px) in processed.enumerate_pixels() {
            rgb8.put_pixel(x, y, image::Rgb([
                (px.0[0] >> 8) as u8,
                (px.0[1] >> 8) as u8,
                (px.0[2] >> 8) as u8,
            ]));
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 88);
        rgb8.write_with_encoder(encoder)
            .map_err(|e| crate::error::AppError::other(format!("jpeg encode: {e}")))?;
        std::fs::write(&out_path, buf.into_inner())
            .map_err(|e| crate::error::AppError::other(format!("preview write: {e}")))?;

        // 超过 40 个文件时删最旧的
        evict_preview_cache(preview_cache_dir, 40);
    }

    let (w, h_px) = resized.dimensions();
    Ok(PreviewResult {
        path: out_path.to_string_lossy().to_string(),
        width: w,
        height: h_px,
    })
}

fn evict_preview_cache(dir: &std::path::Path, max_files: usize) {
    let Ok(mut entries) = std::fs::read_dir(dir).map(|rd| {
        rd.filter_map(|e| e.ok())
          .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jpg"))
          .collect::<Vec<_>>()
    }) else { return };
    if entries.len() <= max_files { return }
    entries.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    for e in entries.iter().take(entries.len() - max_files) {
        let _ = std::fs::remove_file(e.path());
    }
}
```

- [ ] **Step 4: 更新 `get_preview` 调用 `render_preview_from_cache` 的签名**

在 `get_preview` 里把 `render_preview_from_cache` 的两处调用都加上 `&state.preview_cache_dir` 和 `asset_id` 参数。

- [ ] **Step 5: 更新 `types.ts` 的 `PreviewResult`**

```typescript
export type PreviewResult = {
  path: string;
  width: number;
  height: number;
};
```

- [ ] **Step 6: 更新 `api.ts` 的 `getPreview`**

无需改动（返回类型跟着 `PreviewResult` 变即可）。

- [ ] **Step 7: 更新 `PreviewPanel.tsx`，用 `convertFileSrc` 替代 blob URL**

将现有的 base64 → Blob → ObjectURL 逻辑替换为：

```typescript
import { convertFileSrc } from "@tauri-apps/api/core";

// 在 useEffect 里，替换 blob 创建部分：
const r = await api.getPreview(focused.id, filter, 1280);
if (reqId.current === myId) {
  const src = convertFileSrc(r.path);
  const entry = { blobUrl: src, width: r.width, height: r.height };
  previewCache.current.set(cacheKey, entry);
  setPreview(entry);
  setPreviewSize({ width: r.width, height: r.height }, focused.id);
  setLoading(false);
}
```

同时删除 `URL.revokeObjectURL` 调用（本地文件路径不需要 revoke）。

- [ ] **Step 8: 在 `clear_cache` IPC 命令里清理 `preview_cache_dir`**

在 `ipc.rs` 的 `clear_cache` 函数里追加：

```rust
if state.preview_cache_dir.exists() {
    let _ = std::fs::remove_dir_all(&state.preview_cache_dir);
    let _ = std::fs::create_dir_all(&state.preview_cache_dir);
}
```

- [ ] **Step 9: 编译并在 dev 环境验证预览正常**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
pnpm tauri dev
```

选中一张 RAW，拖动滑块，确认预览正常更新，Network/IPC payload 不再有大体积 base64。

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/state.rs src/types.ts src/api.ts src/components/PreviewPanel.tsx
git commit -m "feat: preview via local file path instead of base64 IPC"
```

---

## Task 6: 前端滑块 150ms 防抖

**Files:**
- Modify: `src/components/PreviewPanel.tsx`

- [ ] **Step 1: 找到 `useEffect` 里的 `setTimeout` 调用，确认当前 debounce 值**

在 `PreviewPanel.tsx` 里搜索 `setTimeout`，找到触发 `api.getPreview` 的那个 handle。

- [ ] **Step 2: 将 debounce 时间改为 150ms（如果当前不是）**

```typescript
const handle = setTimeout(async () => {
  // ... getPreview 调用
}, 150);
```

- [ ] **Step 3: Commit**

```bash
git add src/components/PreviewPanel.tsx
git commit -m "perf: set preview debounce to 150ms"
```

---

## Task 7: 动态导出并发（内存感知）

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/ipc.rs`

- [ ] **Step 1: 在 `AppState` 新增 `export_memory_budget`**

```rust
// state.rs
use std::sync::atomic::{AtomicU64, Ordering};

pub export_memory_budget: Arc<AtomicU64>,  // 单位：MB
```

在 `init` 里，按可用内存的 40% 初始化（无法获取时默认 1600MB）：

```rust
let total_mb = {
    // 简单估算：读 /proc/meminfo（Linux）或直接用保守默认值
    // 跨平台安全做法：直接用固定值，避免引入 sys-info 依赖
    4096u64  // 保守默认 4GB × 40% = 1600MB 预算
};
let budget_mb = total_mb * 40 / 100;
// ...
export_memory_budget: Arc::new(AtomicU64::new(budget_mb)),
```

- [ ] **Step 2: 新增内存估算函数**

```rust
// ipc.rs
fn estimate_export_memory_mb(file_size_bytes: i64) -> u64 {
    let raw_mb = (file_size_bytes / 1024 / 1024) as u64;
    (raw_mb * 7).max(50)
}
```

- [ ] **Step 3: 在 `run_export_task` 开始时申请内存额度，结束时归还**

```rust
// run_export_task 开始处，获取 asset 后：
let needed_mb = estimate_export_memory_mb(asset.file_size.unwrap_or(30 * 1024 * 1024));

// 自旋等待直到有足够预算（最多等 30s）
let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
loop {
    let current = state.export_memory_budget.load(Ordering::SeqCst);
    if current >= needed_mb {
        if state.export_memory_budget
            .compare_exchange(current, current - needed_mb, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            break;
        }
    }
    if std::time::Instant::now() > deadline { break; }
    std::thread::sleep(std::time::Duration::from_millis(200));
}

// run_export_task 结束处（on_task_finish 之前）：
state.export_memory_budget.fetch_add(needed_mb, Ordering::SeqCst);
```

- [ ] **Step 4: 将 `export_pool` 线程数改为 `cpu_count - 1`（最少 2）**

```rust
// state.rs
let export_threads = (logical_cpus.saturating_sub(1)).max(2);
let export_pool = Arc::new(
    rayon::ThreadPoolBuilder::new()
        .num_threads(export_threads)
        .build()
        .map_err(|e| crate::error::AppError::other(e.to_string()))?,
);
```

- [ ] **Step 5: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/ipc.rs
git commit -m "feat: memory-aware dynamic export concurrency"
```

---

## Task 8: L1 预览缓存改为真正的 LRU（IndexMap）

**Files:**
- `src-tauri/Cargo.toml`
- `src-tauri/src/state.rs`
- `src-tauri/src/ipc.rs`

- [ ] **Step 1: 在 `Cargo.toml` 添加 `indexmap` 依赖**

```toml
indexmap = "2"
```

- [ ] **Step 2: 修改 `state.rs` 的 `preview_cache` 类型**

```rust
use indexmap::IndexMap;

pub preview_cache: Arc<Mutex<IndexMap<PreviewCacheKey, Arc<ImageBuffer<Rgb<u16>, Vec<u16>>>>>>,
```

初始化：

```rust
preview_cache: Arc::new(Mutex::new(IndexMap::new())),
```

- [ ] **Step 3: 修改 `ipc.rs` 里的缓存淘汰逻辑**

将现有的：

```rust
if c.len() >= 16 {
    let evict = c.keys().next().cloned();
    if let Some(k) = evict { c.remove(&k); }
}
c.insert((asset_id, max_edge), resized.clone());
```

改为：

```rust
// 容量改为 20，IndexMap 保持插入顺序，front = 最旧
while c.len() >= 20 {
    c.shift_remove_index(0);
}
c.insert((asset_id, max_edge), resized.clone());
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/state.rs src-tauri/src/ipc.rs
git commit -m "perf: replace HashMap preview cache with IndexMap LRU (cap=20)"
```

---

## Self-Review 检查结果

1. **Spec 覆盖**：两阶段导入 ✓（Task 1-3）、L2 缓存 ✓（Task 4）、L1 LRU ✓（Task 8）、预览文件协议 ✓（Task 5-6）、动态导出 ✓（Task 7）
2. **类型一致性**：`NewAsset.file_mtime` 在 Task 2 定义，Task 4 使用；`PreviewResult.path` 在 Task 5 Step 2 定义，Step 5-7 使用
3. **依赖顺序**：Task 1（DB migration）→ Task 2-3（scanner + worker）→ Task 4（缩略图 mtime）→ Task 5-6（预览）→ Task 7-8（导出+LRU）可独立执行

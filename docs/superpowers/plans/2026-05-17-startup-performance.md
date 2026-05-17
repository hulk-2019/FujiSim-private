# Startup & Runtime Performance Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除启动时及运行时的高 CPU / 内存占用，涵盖缩略图生成、资产列表渲染、预览渲染、导出、字体加载六个方向。

**Architecture:** 前端通过精确 store 订阅消除无效重渲染，延迟/懒加载非关键初始化；后端通过 Semaphore 限制缩略图并发、独立 rayon 线程池隔离预览与导出、前端请求版本号取消过期预览任务。

**Tech Stack:** Rust (tokio, rayon, tokio::sync::Semaphore), React + Zustand, Tauri IPC

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/components/AssetGrid.tsx` | 修改 | `Thumb` 精确订阅 `rawThumbnailReady.has(id)` |
| `src/store.ts` | 修改 | limit 500→100，延迟触发 generateThumbnails |
| `src/main.tsx` | 修改 | 字体加载改为 requestIdleCallback |
| `src-tauri/src/ipc.rs` | 修改 | generate_thumbnails 加 Semaphore 并发控制；get_preview 加版本号取消机制 |
| `src-tauri/src/state.rs` | 修改 | 新增 preview_pool (rayon, 2线程) 和 thumbnail_sem (Semaphore) |

---

## Task 1：Thumb 精确订阅，消除 500 次重渲染

**Files:**
- Modify: `src/components/AssetGrid.tsx:250-251`

每次 `thumbnail:done` 事件触发 `markThumbnailReady`，500 个 `Thumb` 组件全部重渲染，因为它们都订阅了整个 `rawThumbnailReady` Set。改为每个 Thumb 只订阅自己 id 的布尔值。

- [ ] **Step 1: 修改 Thumb 组件的 store 订阅**

在 [src/components/AssetGrid.tsx:250-251](src/components/AssetGrid.tsx#L250-L251) 将：

```tsx
const rawThumbnailReady = useStore((s) => s.rawThumbnailReady);
const thumbnailDir = useStore((s) => s.thumbnailDir);
```

改为：

```tsx
const isThumbReady = useStore((s) => s.rawThumbnailReady.has(asset.id));
const thumbnailDir = useStore((s) => s.thumbnailDir);
```

- [ ] **Step 2: 更新 src 计算逻辑**

在 [src/components/AssetGrid.tsx:255-264](src/components/AssetGrid.tsx#L255-L264) 将：

```tsx
const src = useMemo(() => {
  if (!asset.is_raw) {
    try { return convertFileSrc(asset.file_path); } catch { return null; }
  }
  if (rawThumbnailReady.has(asset.id) && thumbnailDir) {
    try { return convertFileSrc(`${thumbnailDir}/${asset.id}.jpg`); } catch { return null; }
  }
  return null;
}, [asset.file_path, asset.is_raw, asset.id, rawThumbnailReady, thumbnailDir]);
```

改为：

```tsx
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

- [ ] **Step 3: 验证编译通过**

```bash
cd /Users/ry2019/private/FujiSim && npm run typecheck 2>&1 | tail -20
```

期望：无 TypeScript 错误。

---

## Task 2：默认加载数量 500→100，延迟触发缩略图生成

**Files:**
- Modify: `src/store.ts:192`
- Modify: `src/store.ts:256-260`

- [ ] **Step 1: 修改默认 limit**

在 [src/store.ts:192](src/store.ts#L192) 将：

```ts
query: { sort_by: "date_taken", sort_dir: "desc", limit: 500 },
```

改为：

```ts
query: { sort_by: "date_taken", sort_dir: "desc", limit: 100 },
```

- [ ] **Step 2: 延迟触发 generateThumbnails**

在 [src/store.ts:256-260](src/store.ts#L256-L260) 将：

```ts
const rawIds = list.filter((a) => Boolean(a.is_raw)).map((a) => a.id);
if (rawIds.length > 0) {
  api.generateThumbnails(rawIds).catch(() => {});
}
```

改为：

```ts
const rawIds = list.filter((a) => Boolean(a.is_raw)).map((a) => a.id);
if (rawIds.length > 0) {
  setTimeout(() => api.generateThumbnails(rawIds).catch(() => {}), 600);
}
```

- [ ] **Step 3: 验证编译通过**

```bash
cd /Users/ry2019/private/FujiSim && npm run typecheck 2>&1 | tail -20
```

期望：无 TypeScript 错误。

---

## Task 3：字体加载改为 requestIdleCallback

**Files:**
- Modify: `src/main.tsx:18-20`

- [ ] **Step 1: 修改字体加载时机**

在 [src/main.tsx:18-20](src/main.tsx#L18-L20) 将：

```ts
loadPersistedFonts().then((fonts) => {
  if (fonts.length > 0) useStore.setState({ userFonts: fonts });
});
```

改为：

```ts
const loadFonts = () =>
  loadPersistedFonts().then((fonts) => {
    if (fonts.length > 0) useStore.setState({ userFonts: fonts });
  });

if (typeof requestIdleCallback !== "undefined") {
  requestIdleCallback(loadFonts);
} else {
  setTimeout(loadFonts, 500);
}
```

- [ ] **Step 2: 验证编译通过**

```bash
cd /Users/ry2019/private/FujiSim && npm run typecheck 2>&1 | tail -20
```

期望：无 TypeScript 错误。

---

## Task 4：Rust 后端新增 thumbnail_sem，限制缩略图并发为 2

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/ipc.rs:1184-1225`

### Step 4.1：state.rs 新增 thumbnail_sem 字段

- [ ] **Step 1: 添加 tokio::sync::Semaphore 到 AppState**

在 [src-tauri/src/state.rs](src-tauri/src/state.rs) 中：

将 `use` 区域（文件顶部）改为：

```rust
use crate::error::Result;
use crate::processing::lut::Lut3D;
use crate::queue::TaskQueue;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;
```

将 `AppState` struct 改为（新增最后一行）：

```rust
pub struct AppState {
    pub pool: SqlitePool,
    pub data_dir: PathBuf,
    pub thumbnail_dir: PathBuf,
    pub lut_dir: PathBuf,
    pub watermark_dir: PathBuf,
    pub font_dir: PathBuf,
    pub lut_cache: Mutex<HashMap<PathBuf, Arc<Lut3D>>>,
    pub export_pool: rayon::ThreadPool,
    pub task_queue: TaskQueue,
    /// 限制同时处理的缩略图数量，避免启动时大量 RAW 解码占满 CPU
    pub thumbnail_sem: Arc<Semaphore>,
}
```

将 `AppState::init()` 中 `Arc::new(AppState { ... })` 块改为（新增最后一个字段）：

```rust
let state = Arc::new(AppState {
    pool,
    data_dir,
    thumbnail_dir,
    lut_dir,
    watermark_dir,
    font_dir,
    lut_cache: Mutex::new(HashMap::new()),
    export_pool,
    task_queue: TaskQueue::new(2),
    thumbnail_sem: Arc::new(Semaphore::new(2)),
});
```

- [ ] **Step 2: 验证 Rust 编译通过**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo check 2>&1 | tail -30
```

期望：无编译错误。

### Step 4.2：ipc.rs generate_thumbnails 使用 Semaphore

- [ ] **Step 3: 修改 generate_thumbnails 函数**

在 [src-tauri/src/ipc.rs:1184-1225](src-tauri/src/ipc.rs#L1184-L1225) 将整个函数替换为：

```rust
#[tauri::command]
pub async fn generate_thumbnails(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    asset_ids: Vec<i64>,
) -> Result<()> {
    let mut raw_assets = Vec::new();
    for id in &asset_ids {
        match assets::get(&state.pool, *id).await {
            Ok(a) if a.is_raw != 0 => raw_assets.push(a),
            _ => {}
        }
    }

    let thumbnail_dir = state.thumbnail_dir.clone();
    let sem = state.thumbnail_sem.clone();

    tokio::task::spawn(async move {
        let mut handles = Vec::new();
        for asset in raw_assets {
            let permit = sem.clone().acquire_owned().await;
            let Ok(permit) = permit else { break };
            let thumbnail_dir = thumbnail_dir.clone();
            let app = app.clone();
            handles.push(tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let cache_path = thumbnail_dir.join(format!("{}.jpg", asset.id));
                if cache_path.exists() {
                    let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
                    return;
                }
                let src = std::path::PathBuf::from(&asset.file_path);
                match processing::raw::extract_raw_thumbnail(&src) {
                    Ok(jpeg) => {
                        if let Err(e) = std::fs::write(&cache_path, &jpeg) {
                            tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: write failed");
                            return;
                        }
                        let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
                    }
                    Err(e) => {
                        tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: extract failed");
                    }
                }
            }));
        }
        for h in handles {
            let _ = h.await;
        }
        let _ = app.emit("thumbnail:all_done", ());
    });

    Ok(())
}
```

- [ ] **Step 4: 验证 Rust 编译通过**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo check 2>&1 | tail -30
```

期望：无编译错误。

---

## Task 5：预览渲染独立 rayon 线程池，隔离预览与导出

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/ipc.rs:294-309`

### Step 5.1：state.rs 新增 preview_pool

- [ ] **Step 1: 在 AppState 新增 preview_pool 字段**

在 [src-tauri/src/state.rs](src-tauri/src/state.rs) 的 `AppState` struct 中，在 `export_pool` 后新增：

```rust
pub struct AppState {
    pub pool: SqlitePool,
    pub data_dir: PathBuf,
    pub thumbnail_dir: PathBuf,
    pub lut_dir: PathBuf,
    pub watermark_dir: PathBuf,
    pub font_dir: PathBuf,
    pub lut_cache: Mutex<HashMap<PathBuf, Arc<Lut3D>>>,
    pub export_pool: rayon::ThreadPool,
    /// 预览渲染专用线程池，与导出线程池隔离，避免导出任务阻塞 UI 预览响应
    pub preview_pool: rayon::ThreadPool,
    pub task_queue: TaskQueue,
    pub thumbnail_sem: Arc<Semaphore>,
}
```

在 `AppState::init()` 中，在 `export_pool` 初始化后新增 `preview_pool`：

```rust
let export_pool = rayon::ThreadPoolBuilder::new()
    .num_threads(2)
    .build()
    .map_err(|e| crate::error::AppError::other(e.to_string()))?;

let preview_pool = rayon::ThreadPoolBuilder::new()
    .num_threads(2)
    .build()
    .map_err(|e| crate::error::AppError::other(e.to_string()))?;
```

并在 `Arc::new(AppState { ... })` 中加入：

```rust
let state = Arc::new(AppState {
    pool,
    data_dir,
    thumbnail_dir,
    lut_dir,
    watermark_dir,
    font_dir,
    lut_cache: Mutex::new(HashMap::new()),
    export_pool,
    preview_pool,
    task_queue: TaskQueue::new(2),
    thumbnail_sem: Arc::new(Semaphore::new(2)),
});
```

- [ ] **Step 2: 验证 Rust 编译通过**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo check 2>&1 | tail -30
```

期望：无编译错误。

### Step 5.2：get_preview 使用 preview_pool

- [ ] **Step 3: 修改 get_preview 使用独立线程池**

在 [src-tauri/src/ipc.rs:294-309](src-tauri/src/ipc.rs#L294-L309) 将：

```rust
#[tauri::command]
pub async fn get_preview(
    state: State<'_, SharedState>,
    asset_id: i64,
    settings: Option<FilterSettings>,
    max_edge: Option<u32>,
) -> Result<PreviewResult> {
    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);
    let max_edge = max_edge.unwrap_or(1280);
    let settings = settings.unwrap_or_default();
    let lut = cached_lut(&state, settings.lut_file_path.as_deref())?;
    tokio::task::spawn_blocking(move || render_preview(&path, &settings, max_edge, lut.as_deref()))
        .await
        .map_err(|e| AppError::other(e.to_string()))?
}
```

改为：

```rust
#[tauri::command]
pub async fn get_preview(
    state: State<'_, SharedState>,
    asset_id: i64,
    settings: Option<FilterSettings>,
    max_edge: Option<u32>,
) -> Result<PreviewResult> {
    let asset = assets::get(&state.pool, asset_id).await?;
    let path = PathBuf::from(&asset.file_path);
    let max_edge = max_edge.unwrap_or(1280);
    let settings = settings.unwrap_or_default();
    let lut = cached_lut(&state, settings.lut_file_path.as_deref())?;
    let preview_pool = state.preview_pool.clone();
    tokio::task::spawn_blocking(move || {
        preview_pool.install(|| render_preview(&path, &settings, max_edge, lut.as_deref()))
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}
```

注意：`rayon::ThreadPool` 不是 `Clone`，需要用 `Arc<rayon::ThreadPool>`。回到 state.rs 将 `preview_pool` 和 `export_pool` 类型改为 `Arc<rayon::ThreadPool>`：

在 `state.rs` 中：

```rust
pub export_pool: Arc<rayon::ThreadPool>,
pub preview_pool: Arc<rayon::ThreadPool>,
```

初始化时：

```rust
let export_pool = Arc::new(
    rayon::ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .map_err(|e| crate::error::AppError::other(e.to_string()))?,
);

let preview_pool = Arc::new(
    rayon::ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .map_err(|e| crate::error::AppError::other(e.to_string()))?,
);
```

同时检查 `ipc.rs` 中所有使用 `state.export_pool` 的地方（搜索 `export_pool`），确认它们通过 `.install(|| ...)` 调用，如果原来是直接传给 rayon 全局 API 的，改为 `state.export_pool.install(|| ...)` 形式。

- [ ] **Step 4: 验证 Rust 编译通过**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo check 2>&1 | tail -30
```

期望：无编译错误。

---

## Task 6：预览请求版本号取消机制（前端已有，补充后端幂等）

**Files:**
- Modify: `src/components/PreviewPanel.tsx:49-73`

前端已有 `reqId` 版本号机制（[PreviewPanel.tsx:29](src/components/PreviewPanel.tsx#L29)），但 `setTimeout` 只防止了"发出请求前"的竞争，没有取消"已发出但未返回"的旧请求。改为使用 `AbortController` 模式——由于 Tauri IPC 不支持原生 abort，改为在 effect 清理时忽略旧结果（当前逻辑已通过 `reqId.current === myId` 实现），但 `setTimeout` 延迟太短（80ms）导致快速切换时仍会堆积请求。将防抖延迟从 80ms 提升到 150ms，减少堆积。

- [ ] **Step 1: 将预览防抖延迟从 80ms 改为 150ms**

在 [src/components/PreviewPanel.tsx:71](src/components/PreviewPanel.tsx#L71) 将：

```ts
    }, 80);
```

改为：

```ts
    }, 150);
```

- [ ] **Step 2: 验证编译通过**

```bash
cd /Users/ry2019/private/FujiSim && npm run typecheck 2>&1 | tail -20
```

期望：无 TypeScript 错误。

---

## Task 7：全量验证

- [ ] **Step 1: 前端完整类型检查**

```bash
cd /Users/ry2019/private/FujiSim && npm run typecheck 2>&1
```

期望：0 errors。

- [ ] **Step 2: Rust 完整编译**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo build 2>&1 | tail -40
```

期望：`Finished` 行，无 error。

- [ ] **Step 3: 启动应用验证**

```bash
cd /Users/ry2019/private/FujiSim && npm run tauri dev 2>&1 &
```

手动验证：
1. 启动后 CPU 不再持续高占用（缩略图生成限速为 2 并发）
2. 切换图片时预览响应正常，不堆积大量 blocking 任务
3. 导出任务运行时预览仍然响应（独立线程池隔离）
4. 资产列表首次加载 100 张，速度明显快于 500 张

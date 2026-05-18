# 封面图快速生成 + 预览图懒加载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 封面图跳过 orientation 校正只做快速缩放，预览图改为用户点击时懒加载，消除批量预生成的性能瓶颈。

**Architecture:** `generate_thumbnails` 只生成 400px 封面图（`extract_cover_fast`，1次解码+1次编码，无旋转），写 `cover_path` 到 DB。预览图（`thumbnail_path`）由 `get_raw_thumbnail` 懒加载：首次点击时提取写盘并更新 DB，返回磁盘路径字符串，前端用 `convertFileSrc` 加载，彻底消除 base64。

**Tech Stack:** Rust / sqlx / image 0.25 / Tauri / React / TypeScript

---

### Task 1: `extract_cover_fast` + 清理旧函数

**Files:**
- Modify: `src-tauri/src/processing/raw.rs`

当前文件末尾有 `extract_thumbnail_and_cover`（合并函数，本次优化后不再需要）和 `resize_jpeg_to_cover`（独立缩放函数，也不再需要）。本 Task 删除这两个函数，新增 `extract_cover_fast`。

- [ ] **Step 1: 删除 `extract_thumbnail_and_cover` 和 `resize_jpeg_to_cover`**

找到并删除从 `pub fn extract_thumbnail_and_cover` 到文件末尾的全部内容（包含这两个函数）。

- [ ] **Step 2: 在文件末尾追加 `extract_cover_fast`**

```rust
/// 从 RAW 文件提取嵌入 JPEG，缩放到指定长边后返回 JPEG 字节。
///
/// 跳过 orientation 校正（400px 封面图旋转偏差可接受），只做：
/// 提取 → 解码 → Triangle 缩放 → 编码，共 1次解码 + 1次编码。
pub fn extract_cover_fast(path: &Path, max_edge: u32) -> Result<Vec<u8>> {
    let data = std::fs::read(path)?;

    let jpeg = if let Ok(j) = extract_thumb_rsraw(&data) {
        j
    } else {
        extract_thumb_tiff(&data)?
    };

    let img = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
        .map_err(|e| AppError::other(format!("cover decode: {e}")))?;

    let (w, h) = (img.width(), img.height());
    let resized = if w.max(h) > max_edge {
        let scale = max_edge as f32 / w.max(h) as f32;
        let nw = ((w as f32 * scale).round() as u32).max(1);
        let nh = ((h as f32 * scale).round() as u32).max(1);
        img.resize(nw, nh, image::imageops::FilterType::Triangle)
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

- [ ] **Step 3: 编译验证**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo build 2>&1 | grep -E "^error|Finished"
```

期望：`Finished` 无 error。如有 `resize_jpeg_to_cover` 或 `extract_thumbnail_and_cover` 的引用报错，说明 ipc.rs 还在用旧函数，先记录，Task 3 会修复。

---

### Task 2: `update_cover_path` DB 函数

**Files:**
- Modify: `src-tauri/src/db/assets.rs`

- [ ] **Step 1: 在 `update_thumbnail_path` 函数之后追加 `update_cover_path`**

```rust
pub async fn update_cover_path(
    pool: &SqlitePool,
    id: i64,
    cover_path: &str,
) -> Result<()> {
    sqlx::query("UPDATE assets SET cover_path = ? WHERE id = ?")
        .bind(cover_path)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
```

- [ ] **Step 2: 编译验证**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo build 2>&1 | grep -E "^error|Finished"
```

期望：`Finished` 无 error。

---

### Task 3: 简化 `generate_thumbnails` 命令

**Files:**
- Modify: `src-tauri/src/ipc.rs`

`generate_thumbnails` 当前调用 `extract_thumbnail_and_cover`，生成 thumbnail + cover 两个文件。本 Task 改为只生成 cover，调用 `extract_cover_fast`。

- [ ] **Step 1: 找到 `generate_thumbnails` 的 `spawn_blocking` 闭包（约 1268 行）**

读取 `src-tauri/src/ipc.rs` 第 1260-1330 行确认当前结构。

- [ ] **Step 2: 替换闭包内容**

将 `spawn_blocking` 闭包（从 `let _permit = permit;` 到最后一个 `let _ = app.emit(...)` 之前）替换为：

```rust
handles.push(tokio::task::spawn_blocking(move || {
    let _permit = permit;
    let cover_path = cover_dir.join(format!("{}.jpg", asset.id));

    // 幂等：cover 文件存在且 DB 路径已记录则跳过
    if asset.cover_path.is_some() && cover_path.exists() {
        let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
        return;
    }

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

    let cp = cover_path.to_string_lossy().to_string();
    let _ = tokio::runtime::Handle::current().block_on(
        assets::update_cover_path(&pool_ref, asset.id, &cp)
    );

    let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
}));
```

- [ ] **Step 3: 移除 `thumbnail_dir` 和 `thumbnail_path` 相关变量**

闭包外不再需要 `thumbnail_dir`（封面图只用 `cover_dir`）。检查并移除：
- `let thumbnail_dir = state.thumbnail_dir.clone();`（如果只在此闭包中使用）
- 循环内的 `let thumbnail_dir = thumbnail_dir.clone();`

注意：`thumbnail_dir` 在 `get_raw_thumbnail` 命令中仍然使用，只需移除 `generate_thumbnails` 函数内的克隆。

- [ ] **Step 4: 编译验证**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo build 2>&1 | grep -E "^error|Finished"
```

期望：`Finished` 无 error。

---

### Task 4: `get_raw_thumbnail` 改为返回路径字符串

**Files:**
- Modify: `src-tauri/src/ipc.rs`

当前 `get_raw_thumbnail` 返回 `PreviewResult`（含 base64 data）。改为：
1. 检查 `asset.thumbnail_path` 是否存在且文件在磁盘上 → 直接返回路径字符串
2. 未命中 → 提取嵌入 JPEG（含 orientation 校正）→ 写盘 → 更新 DB → 返回路径字符串

- [ ] **Step 1: 替换 `get_raw_thumbnail` 函数**

找到并替换整个 `get_raw_thumbnail` 函数（约第 896-932 行）：

```rust
/// 懒加载 RAW 预览图：优先读 DB 中记录的磁盘路径，命中时直接返回路径。
/// 未命中时提取嵌入 JPEG（含 orientation 校正）写盘，更新 DB，返回路径。
/// 前端用 convertFileSrc(path) 加载，无 base64 开销。
#[tauri::command]
pub async fn get_raw_thumbnail(
    state: State<'_, SharedState>,
    asset_id: i64,
) -> Result<String> {
    let asset = assets::get(&state.pool, asset_id).await?;
    let cache_path = state.thumbnail_dir.join(format!("{asset_id}.jpg"));
    let pool = state.pool.clone();

    // DB 路径已记录且文件存在：直接返回
    if asset.thumbnail_path.is_some() && cache_path.exists() {
        return Ok(cache_path.to_string_lossy().to_string());
    }

    let file_path = std::path::PathBuf::from(&asset.file_path);
    tokio::task::spawn_blocking(move || {
        let bytes = processing::raw::extract_raw_thumbnail(&file_path)?;
        std::fs::write(&cache_path, &bytes)
            .map_err(|e| AppError::other(format!("thumbnail write: {e}")))?;
        let tp = cache_path.to_string_lossy().to_string();
        let _ = tokio::runtime::Handle::current().block_on(
            assets::update_thumbnail_path(&pool, asset_id, &tp)
        );
        Ok(tp)
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}
```

- [ ] **Step 2: 编译验证**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo build 2>&1 | grep -E "^error|Finished"
```

期望：`Finished` 无 error。

---

### Task 5: 前端适配

**Files:**
- Modify: `src/api.ts`
- Modify: `src/store.ts`
- Modify: `src/components/PreviewPanel.tsx`
- Modify: `src/components/AssetGrid.tsx`

- [ ] **Step 1: `api.ts` — 修改 `getRawThumbnail` 返回类型**

将：
```ts
getRawThumbnail: (assetId: number) =>
  invoke<PreviewResult>("get_raw_thumbnail", { assetId }),
```
改为：
```ts
/** 懒加载 RAW 预览图，返回磁盘绝对路径，用 convertFileSrc(path) 加载。 */
getRawThumbnail: (assetId: number) =>
  invoke<string>("get_raw_thumbnail", { assetId }),
```

- [ ] **Step 2: `store.ts` — 新增 `patchAsset` action**

在 store 的 state 类型定义中（`// ===== Actions =====` 附近）追加：
```ts
/** 用新数据替换 assets 数组中对应 id 的条目（局部更新，不触发全量刷新） */
patchAsset: (asset: Asset) => void;
```

在 store 实现末尾（`clearThumbnailReady` 之后）追加：
```ts
patchAsset: (asset) => {
  const assets = get().assets.map((a) => (a?.id === asset.id ? asset : a));
  set({ assets });
},
```

- [ ] **Step 3: `PreviewPanel.tsx` — 更新 Phase 1 thumbSrc 懒加载逻辑**

找到当前 Phase 1 useEffect（约第 68-98 行），在 `focused.is_raw` 分支中，`thumbnail_path` 为 null 时改为调用 `getRawThumbnail`：

```ts
useEffect(() => {
  if (!focused) {
    setThumbSrc(null);
    return;
  }
  if (focused.is_raw) {
    if (focused.thumbnail_path) {
      try {
        setThumbSrc(convertFileSrc(focused.thumbnail_path));
      } catch {
        setThumbSrc(null);
      }
    } else {
      // 懒加载：调用后端提取并写盘，返回路径
      api.getRawThumbnail(focused.id)
        .then((path) => {
          try { setThumbSrc(convertFileSrc(path)); } catch { setThumbSrc(null); }
          useStore.getState().patchAsset({ ...focused, thumbnail_path: path });
        })
        .catch(() => setThumbSrc(null));
    }
  } else {
    try {
      setThumbSrc(convertFileSrc(focused.file_path));
    } catch {
      setThumbSrc(null);
    }
  }
}, [focused?.id, focused?.file_path, focused?.is_raw, focused?.thumbnail_path]);
```

注意：依赖数组移除了 `rawThumbnailReady` 和 `thumbnailDir`（不再需要）。

- [ ] **Step 4: `PreviewPanel.tsx` — 更新 `handleShowOriginal` 和 `originalSrc`**

将 `originalPreview` state 相关代码全部移除，改为直接使用 `focused.thumbnail_path`：

移除这些 state 声明：
```ts
const [originalPreview, setOriginalPreview] = useState<PreviewResult | null>(null);
const [originalLoading, setOriginalLoading] = useState(false);
const [originalError, setOriginalError] = useState<string | null>(null);
```

移除这个 useEffect（重置 originalPreview）：
```ts
useEffect(() => {
  setOriginalPreview(null);
  setOriginalError(null);
}, [focused?.id]);
```

将 `handleShowOriginal` 改为：
```ts
async function handleShowOriginal() {
  setShowOriginal(true);
  if (focused?.is_raw && !focused.thumbnail_path) {
    try {
      const path = await api.getRawThumbnail(focused.id);
      useStore.getState().patchAsset({ ...focused, thumbnail_path: path });
    } catch {
      // 静默失败，originalSrc 保持 null
    }
  }
}
```

将 `originalSrc` 计算改为：
```ts
const originalSrc = focused.is_raw
  ? (focused.thumbnail_path ? convertFileSrc(focused.thumbnail_path) : null)
  : convertFileSrc(focused.file_path);
```

将 JSX 中 `originalLoading` 和 `originalError` 的显示块移除（不再需要）。

- [ ] **Step 5: `PreviewPanel.tsx` — 移除不再使用的 import**

检查并移除不再使用的 import：
- `rawThumbnailReady`（从 store 取的）
- `thumbnailDir`（从 store 取的）
- `PreviewResult` 类型（如果不再使用）

- [ ] **Step 6: `AssetGrid.tsx` — 移除旧降级路径**

找到 `AssetCard` 的 `src` useMemo，移除 `isThumbReady && thumbnailDir` 的降级分支（该路径依赖 `thumbnails/` 目录，新流程不再写入该目录）：

```ts
const src = useMemo(() => {
  if (!asset.is_raw) {
    try { return convertFileSrc(asset.file_path); } catch { return null; }
  }
  if (asset.cover_path) {
    try { return convertFileSrc(asset.cover_path); } catch { return null; }
  }
  return null;
}, [asset.file_path, asset.is_raw, asset.id, asset.cover_path]);
```

同时移除 `isThumbReady` 和 `thumbnailDir` 的 store 订阅（如果 `AssetCard` 中不再使用）：
```ts
// 移除这两行
const isThumbReady = useStore((s) => s.rawThumbnailReady.has(asset.id));
const thumbnailDir = useStore((s) => s.thumbnailDir);
```

- [ ] **Step 7: TypeScript 类型检查**

```bash
cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit 2>&1 | tail -20
```

期望：无 error。如有 `PreviewResult` 相关类型错误，检查 `PreviewPanel.tsx` 中是否还有残留引用。

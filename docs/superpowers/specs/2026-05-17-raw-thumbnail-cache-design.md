# RAW 缩略图磁盘缓存 + 预览原图加速

**日期**：2026-05-17  
**分支**：feature/raw

---

## 背景

两个已知问题：
1. 导入 RAW/DNG 文件后，素材列表（AssetGrid）没有封面图，只显示文件图标
2. 预览原图（按住"对比"按钮）每次都要重新走 LibRaw 解码，速度慢且无缓存

---

## 目标

- RAW/DNG 文件在素材列表中显示封面缩略图，批量预取、磁盘缓存、幂等
- 缩略图逐张生成时前端实时更新（不等全部完成再刷新）
- 「按住看原图」第二次起直接读磁盘，几乎零延迟

---

## 后端设计

### 1. 新增 IPC 命令：`generate_thumbnails`

**签名**：
```rust
pub async fn generate_thumbnails(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    asset_ids: Vec<i64>,
) -> Result<()>
```

**流程**：
1. 从数据库批量读出 `asset_ids` 对应的资产，过滤 `is_raw=1`
2. 在 `tokio::task::spawn_blocking` 中串行处理每张：
   - 检查 `thumbnails/{id}.jpg` 是否存在 → 存在则跳过（幂等）
   - 调用已有的 `processing::raw::extract_raw_thumbnail` 提取嵌入 JPEG
   - 写入 `state.thumbnail_dir/{id}.jpg`
   - 推送 `thumbnail:done` 事件：`{ asset_id: i64 }`
3. 全部处理完毕后推送 `thumbnail:all_done`（无载荷）
4. 单张失败用 `tracing::warn` 记录后继续，不中断整批

### 2. 修改 `get_raw_thumbnail`

在现有逻辑前插入磁盘缓存读取：
```
thumbnail_dir/{asset_id}.jpg 存在？
  ↳ 是 → 读文件 → 解析宽高 → 返回 PreviewResult
  ↳ 否 → 原有 extract_raw_thumbnail 路径 → 写盘 → 返回
```
写盘后下次「按住对比」直接命中，不再解码。

### 3. 新增 IPC 命令：`get_thumbnail_dir`

```rust
pub async fn get_thumbnail_dir(state: State<'_, SharedState>) -> Result<String>
```
返回 `thumbnail_dir` 的绝对路径字符串，供前端拼接 `convertFileSrc` 用。

### 4. `clear_all_data` 联动清空缩略图

在现有 `clear_all_data` 里补充：
```rust
if state.thumbnail_dir.exists() {
    let _ = std::fs::remove_dir_all(&state.thumbnail_dir);
    let _ = std::fs::create_dir_all(&state.thumbnail_dir);
}
```

### 5. 事件定义

| 事件名 | 载荷类型 | 含义 |
|--------|----------|------|
| `thumbnail:done` | `{ asset_id: i64 }` | 单张缩略图写盘完成 |
| `thumbnail:all_done` | 无 | 本批全部处理完毕 |

---

## 前端设计

### 1. Store 新增字段

```ts
thumbnailDir: string | null        // get_thumbnail_dir 返回值，App 启动时获取一次
rawThumbnailReady: Set<number>     // 已确认有磁盘缩略图的 asset_id 集合
```

新增 actions：
- `setThumbnailDir(dir: string)`
- `markThumbnailReady(assetId: number)`

### 2. App 初始化

`App.tsx` 启动时：
1. 调用 `api.getThumbnailDir()` → `store.setThumbnailDir(...)`
2. 监听 `thumbnail:done` → `store.markThumbnailReady(event.payload.asset_id)`
3. 监听 `thumbnail:all_done` → 无需额外操作（逐张已更新）

### 3. `refreshAssets` 联动触发缩略图生成

`refreshAssets` 完成后（原有逻辑不变），追加：
```ts
const rawIds = assets.filter(a => Boolean(a.is_raw)).map(a => a.id)
if (rawIds.length > 0) {
  api.generateThumbnails(rawIds)  // fire-and-forget，不 await
}
```

### 4. `Thumb` 组件修改

`src` 的计算逻辑：
```ts
const src = useMemo(() => {
  if (!asset.is_raw) {
    try { return convertFileSrc(asset.file_path) } catch { return null }
  }
  // RAW：有磁盘缩略图时用 convertFileSrc，否则返回 null（显示图标）
  if (rawThumbnailReady.has(asset.id) && thumbnailDir) {
    try { return convertFileSrc(`${thumbnailDir}/${asset.id}.jpg`) } catch { return null }
  }
  return null
}, [asset.file_path, asset.is_raw, rawThumbnailReady, thumbnailDir])
```

### 5. `api.ts` 新增

```ts
getThumbnailDir: () => invoke<string>("get_thumbnail_dir"),
generateThumbnails: (assetIds: number[]) =>
  invoke<void>("generate_thumbnails", { assetIds }),
```

---

## 数据流

```
refreshAssets()
  └─ list_assets → store.assets 更新
  └─ generate_thumbnails(rawIds) [fire-and-forget]
       └─ 后端串行处理每张
            └─ 写盘 thumbnails/{id}.jpg
            └─ emit thumbnail:done { asset_id }
                 └─ 前端 store.markThumbnailReady(id)
                      └─ Thumb 组件重渲染，显示封面图

按住「对比原图」
  └─ get_raw_thumbnail(asset_id)
       └─ thumbnails/{id}.jpg 存在？
            ↳ 是 → 读文件返回（<5ms）
            ↳ 否 → extract_raw_thumbnail + 写盘 + 返回
```

---

## 不在本次范围内

- 滤镜预览（`get_preview`）的缓存：参数可变，本次不做
- 缩略图尺寸限制（当前直接用嵌入 JPEG 原始尺寸，通常 1~3MB，足够列表用）
- 并发生成（当前串行，避免 IO 竞争和内存峰值）

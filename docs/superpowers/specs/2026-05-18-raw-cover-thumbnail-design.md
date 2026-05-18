# RAW 封面图与预览图磁盘缓存设计

**日期：** 2026-05-18

## 背景

当前 `generate_thumbnails` 命令从 RAW/DNG 文件中提取相机嵌入的 JPEG 写到 `thumbnails/{id}.jpg`，但：

1. 嵌入 JPEG 分辨率不可控（相机决定，可达 1920px+），作为 AssetGrid 小图加载开销大
2. AssetGrid 通过 `thumbnailDir + id` 路径拼接加载，路径未持久化到 DB，无法做幂等判断
3. PreviewPanel 通过 `get_raw_thumbnail` IPC 返回 base64，内存开销高

## 目标

- 新增 400px 长边的**封面图**用于 AssetGrid，提升网格加载效率
- 保留现有 `thumbnails/{id}.jpg` 作为 PreviewPanel 的**原图预览图**
- 将两个路径持久化到 `assets` 表，避免重复解析 RAW 文件
- PreviewPanel 改为文件协议加载，彻底消除 base64 IPC 开销

---

## 数据层

### assets 表新增字段

通过增量迁移（`ALTER TABLE ... ADD COLUMN`）添加，与现有迁移模式一致：

```sql
ALTER TABLE assets ADD COLUMN thumbnail_path TEXT;  -- thumbnails/{id}.jpg 绝对路径
ALTER TABLE assets ADD COLUMN cover_path TEXT;       -- covers/{id}.jpg 绝对路径
```

NULL 表示尚未生成。

### Rust struct 变更

`Asset`（读模型）和 `NewAsset`（写模型）各增加：

```rust
pub thumbnail_path: Option<String>,
pub cover_path: Option<String>,
```

新增数据库操作函数：

```rust
pub async fn update_thumbnail_paths(
    pool: &SqlitePool,
    id: i64,
    thumbnail_path: &str,
    cover_path: &str,
) -> Result<()>
```

### 目录结构

`state.rs` 新增 `cover_dir: PathBuf`，指向 `data_dir/covers/`，初始化时创建目录。

---

## 生成逻辑

### 扩展 `generate_thumbnails` 命令

每张 RAW 的处理流程：

1. **幂等检查**：`asset.thumbnail_path` 和 `asset.cover_path` 均非 NULL 且文件存在 → 跳过，直接推送 `thumbnail:done`
2. **提取预览图**：`extract_raw_thumbnail(path)` → 写到 `thumbnails/{id}.jpg`（现有逻辑不变）
3. **生成封面图**：`resize_jpeg_to_cover(&jpeg, 400)` → 写到 `covers/{id}.jpg`
4. **持久化路径**：`update_thumbnail_paths(pool, id, thumbnail_path, cover_path)`
5. **推送事件**：`thumbnail:done { asset_id }`（payload 结构不变）

### 新增纯函数

在 `processing/raw.rs` 新增：

```rust
pub fn resize_jpeg_to_cover(jpeg: &[u8], max_edge: u32) -> Result<Vec<u8>>
```

功能：JPEG 解码 → 按比例缩放（长边不超过 `max_edge`）→ 重新编码为 JPEG。与提取逻辑完全解耦。

---

## 前端改动

### 类型层（`src/api.ts`）

`Asset` 类型新增：

```ts
thumbnail_path: string | null;
cover_path: string | null;
```

### AssetGrid

`src` 计算逻辑优先使用 `cover_path`：

```ts
if (asset.cover_path) return convertFileSrc(asset.cover_path);
// 回退：兼容旧数据（cover_path 为 null 时）
if (isThumbReady && thumbnailDir) return convertFileSrc(`${thumbnailDir}/${asset.id}.jpg`);
return null;
```

### PreviewPanel

- `thumbnail_path` 有值 → `<img src={convertFileSrc(asset.thumbnail_path)}>` 文件协议直接加载，零 base64 开销
- `thumbnail_path` 为 null（未生成）→ 回退到现有 `get_raw_thumbnail` IPC（返回 base64）

`get_raw_thumbnail` 降级为兼容路径，长期所有已生成缩略图的 RAW 均走文件协议。

---

## 不变的部分

- `generate_thumbnails` 命令的调用时机和前端触发逻辑不变
- `thumbnail:done` / `thumbnail:all_done` 事件 payload 结构不变
- `get_raw_thumbnail` IPC 保留，作为降级路径
- Semaphore 并发限制（2）不变
- 导入流程不变

---

## 边界情况

| 情况 | 处理方式 |
|------|---------|
| RAW 文件无嵌入 JPEG（`extract_raw_thumbnail` 失败） | 跳过该资产，记录 warning，不更新 DB 路径 |
| 封面图生成失败（`resize_jpeg_to_cover` 失败） | 仍写入 `thumbnail_path`，`cover_path` 保持 NULL，记录 warning |
| 磁盘写入失败 | 不更新 DB 路径，下次重新触发时重试 |
| 旧数据（`cover_path` 为 NULL） | AssetGrid 回退到 `thumbnailDir + id` 拼接，行为与现在一致 |
| 重置缓存（`clear_cache` 命令） | 同时清空 `covers/` 目录；需在 `clear_cache` 里补上清除逻辑，并将所有 `thumbnail_path`/`cover_path` 置 NULL |

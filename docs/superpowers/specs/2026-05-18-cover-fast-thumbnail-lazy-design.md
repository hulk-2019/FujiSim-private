# 封面图快速生成 + 预览图懒加载设计

**日期：** 2026-05-18

## 背景

当前 `generate_thumbnails` 命令对每张 RAW 文件：
1. 读取整个文件（20-50MB）
2. 提取嵌入 JPEG
3. 解码 JPEG → 应用 orientation → 重编码（第1次解码/编码）
4. 再次解码 → Lanczos3 缩放 → 重编码（第2次解码/编码）

即使合并后仍需 1次解码 + 2次编码，且批量预生成所有资产的预览图（用户不一定会查看）。

## 目标

- **封面图**（AssetGrid）：跳过 orientation 校正，只做提取 + 快速缩放，速度提升 2-3x
- **预览图**（PreviewPanel）：懒加载，用户点击时才生成，不再批量预生成
- 两者路径仍持久化到 `assets` 表，保持幂等

---

## 封面图生成

### 新函数 `extract_cover_fast`

在 `processing/raw.rs` 新增：

```rust
pub fn extract_cover_fast(path: &Path, max_edge: u32) -> Result<Vec<u8>>
```

流程：
1. 读取 RAW 文件
2. 提取嵌入 JPEG（rsraw 主路径 + TIFF 降级，与现有逻辑相同）
3. **跳过 orientation 校正**（400px 小图旋转偏差可接受）
4. 解码 JPEG → Triangle 缩放到 `max_edge` 长边 → 重编码 JPEG

相比现有 `extract_thumbnail_and_cover`：省去 orientation 旋转操作，只有 1次解码 + 1次编码。

### `generate_thumbnails` 命令简化

只生成封面图，不再生成预览图：

```
extract_cover_fast(path, 400) → 写 covers/{id}.jpg → update_cover_path(pool, id, path)
```

`thumbnail_path` 不在此处写入，由懒加载路径负责。

幂等条件简化为：`asset.cover_path.is_some() && cover_path.exists()`。

### DB 操作新增

```rust
pub async fn update_cover_path(pool, id, cover_path) -> Result<()>
```

---

## 预览图懒加载

### `get_raw_thumbnail` 命令扩展

当前：提取嵌入 JPEG → 写盘 → 返回 base64。

扩展后：
1. 检查 `asset.thumbnail_path` 是否存在且文件在磁盘上 → 命中则**直接返回路径字符串**（不再返回 base64）
2. 未命中：提取嵌入 JPEG（含 orientation 校正）→ 写 `thumbnails/{id}.jpg` → 调用 `update_thumbnail_path` 写 DB → 返回路径字符串

返回类型从 `PreviewResult`（含 base64 data）改为只返回路径字符串 `String`。

### 前端 PreviewPanel

当前 Phase 1 逻辑：
- `thumbnail_path` 有值 → `convertFileSrc(thumbnail_path)`（已实现）
- 无值 → 降级到 `rawThumbnailReady` 集合 + `thumbnailDir` 拼接

扩展后：
- `thumbnail_path` 有值 → `convertFileSrc(thumbnail_path)`（不变）
- 无值 → 调用 `api.getRawThumbnail(asset.id)` → 后端返回路径 → `convertFileSrc(path)` → 同时更新 store 中 asset 的 `thumbnail_path`

`getRawThumbnail` 返回类型从 `PreviewResult` 改为 `string`（路径）。

### store 中 `markThumbnailReady` 调整

`thumbnail:done` 事件不再用于预览图（预览图懒加载，不走批量事件）。`markThumbnailReady` 改为只标记封面图就绪（`cover_path` 已写入），触发 AssetGrid 重渲染。

---

## 不变的部分

- `assets` 表结构不变（`thumbnail_path`、`cover_path` 字段已存在）
- `thumbnail:done` 事件 payload 不变（仍只带 `asset_id`）
- `clear_all_data` 清空逻辑不变
- `get_preview`（色彩流水线预览）完全不涉及

---

## 边界情况

| 情况 | 处理方式 |
|------|---------|
| 封面图提取失败 | warn + 跳过，`cover_path` 保持 NULL，下次重试 |
| 预览图提取失败 | `get_raw_thumbnail` 返回错误，PreviewPanel 显示错误状态 |
| 旧数据（`cover_path` NULL） | AssetGrid 降级到 `thumbnailDir + id` 拼接（已有兼容逻辑） |
| 旧数据（`thumbnail_path` NULL） | PreviewPanel 调用 `get_raw_thumbnail` 懒加载，行为与现在一致 |
| 用户快速切换资产 | PreviewPanel 用 `reqId` 取消过期请求（已有机制，不变） |

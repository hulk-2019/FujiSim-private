# FujiSim 性能优化设计文档（Lightroom 级体验）

| 项目 | FujiSim |
| :--- | :--- |
| 版本 | v1.1 |
| 日期 | 2026-05-18 |
| 状态 | 待实现 |

---

## 1. 背景与目标

当前版本在以下场景存在明显性能瓶颈：

| 场景 | 现状 | 目标 |
|---|---|---|
| 导入 500 张 RAW | UI 卡死 ~30s | <1s 可见网格 |
| 冷启动加载网格 | 重新生成所有缩略图 | 磁盘缓存命中，秒开 |
| 批量导出 100 张 | 固定 2 线程，慢 | 动态并发，2-4x 提升 |
| 滑块拖动预览 | base64 IPC，~200ms | 本地文件协议，~50ms |

目标是在不引入 C 依赖（不用 libvips）的前提下，通过架构调整达到接近 Lightroom 的交互体验。

---

## 2. 模块一：两阶段导入

### 2.1 问题

`scanner::scan_dir` 在遍历时对每张 RAW 同步调用 `extract_meta`，内部读文件 + 解 EXIF + 读尺寸。500 张 RAF 约需 15-30 秒，期间 UI 显示 loading。

### 2.2 设计

**阶段一：快速入库（目标 <1s）**

- `scan_dir` 只记录 `file_path / file_name / file_type / file_size / is_raw`，不读文件内容
- 路径收集用 `walkdir`（单线程），元数据提取用 `rayon::par_iter` 并行（只读 `fs::metadata`，无文件 IO）
- 批量 INSERT 后立刻 emit `import:done`，前端刷新网格显示占位格

**阶段二：后台 EXIF 补全（目标 <30s/500 张）**

- `import:done` 后，后端自动启动后台 worker
- 从数据库取出 `exif_extracted = 0` 的资产，用 `rayon` 并行提取 EXIF
- 并发数固定为 **4**（EXIF 提取是 IO 密集，4 并发足以打满 SSD IOPS，不随 CPU 核数扩展）
- 每完成 20 张 emit `exif:batch_done { ids: [...] }`，前端局部刷新元数据
- 每张只读文件头部（`kamadak-exif` 默认 64KB），4 并发峰值内存约 256KB

**资源控制**：

- EXIF worker 使用独立 `exif_sem`（Semaphore，permits=4），与 `preview_pool` / `export_pool` 完全隔离
- 用户感知：风扇可能轻微转快几秒，UI 无卡顿

**数据库变更**：

```sql
ALTER TABLE assets ADD COLUMN exif_extracted INTEGER NOT NULL DEFAULT 0;
```

### 2.3 接口变更

| 变更 | 说明 |
|---|---|
| `scanner::scan_dir` | 移除 `extract_meta` 调用，只收集路径和文件系统元数据 |
| `ipc::import_directory` | `import:done` 后异步启动 EXIF worker |
| 新增 `ipc::extract_exif_background` | 内部函数，不暴露给前端 |
| 新增事件 `exif:batch_done` | payload: `{ ids: number[] }` |

---

## 3. 模块二：分级缓存

### 3.1 三级缓存结构

```
L1  内存 LRU        预览底图（16-bit RGB）    20 张 ≈ 130MB
L2  磁盘缩略图      256px JPEG               按需生成，永久保留
L3  磁盘预览图      1280px JPEG              可选，默认关闭
```

### 3.2 L2 磁盘缩略图

**文件命名**：`{cover_dir}/{asset_id}_{mtime_secs}.jpg`

- 查找时先算期望路径，文件存在则直接返回路径（不走 IPC）
- mtime 变化时旧缓存自动失效，新缓存按需生成
- 前端用 `convertFileSrc(path)` 加载，不走 base64

**孤儿文件清理**：启动时扫描 `cover_dir`，删除 asset_id 不在数据库中的文件。

### 3.3 L1 内存预览缓存

- 容量从 16 张改为 **20 张**，约 130MB
- 淘汰策略：用 `IndexMap`（保持插入顺序）替代 `HashMap`，超限时删 front，实现 FIFO 近似 LRU，不引入新依赖
- 8GB 内存机器可在 `AppState::init` 里按可用内存动态调整容量

### 3.4 L3 磁盘预览图（可选）

- `AppState` 新增 `preview_disk_cache: bool`，默认 `false`
- 开启后 `get_preview` 在 L1 miss 时先查磁盘，miss 才走完整解码，解码完写盘
- 路径：`{data_dir}/preview_cache/{asset_id}_{settings_hash}.jpg`

### 3.5 前端变更

`AssetGrid` 中缩略图 src 逻辑：

```
现在：convertFileSrc(`${coverDir}/${asset.id}.jpg`)
改后：convertFileSrc(`${coverDir}/${asset.id}_${asset.mtime}.jpg`)
```

需要 `Asset` 类型新增 `mtime: number` 字段（从数据库 `file_mtime` 列读取）。

---

## 4. 模块三：批量导出优化

### 4.1 动态并发 + 内存感知调度

**现状**：`export_pool` 固定 2 线程，原因是防止大 RAW 并发解码导致内存溢出（每张约 144MB）。

**改造**：

```rust
fn estimate_memory_mb(file_size_bytes: i64) -> u32 {
    // RAW 解压后约是文件大小的 7 倍（12-bit Bayer → 16-bit RGB × 3 channels）
    let raw_mb = (file_size_bytes / 1024 / 1024) as u32;
    (raw_mb * 7).max(50)
}
```

`AppState` 新增 `export_memory_budget: Arc<AtomicU64>`，初始值 = 可用内存 × 40%。

每个导出任务开始前申请预估内存额度，结束后归还。超出预算时阻塞等待，不直接启动新任务。

**效果**：
- 导出小 JPEG：可跑 8-10 并发
- 导出大 RAW（30MB 文件）：自动降到 2-3 并发
- 比固定 2 线程快 2-4x

### 4.2 进度事件简化

```
现在：每张图发 2 次事件（开始 + 结束）
改后：每张完成发 1 次，payload: { completed, failed, total, percent }
```

### 4.3 快速预览导出模式（可选）

用户选择"导出预览质量"时，若 L2/L3 缓存存在则直接读缓存，跳过全分辨率解码，速度快 10x 以上。默认走全分辨率。

---

## 5. 模块四：原图快速预览

### 5.1 问题

`get_preview` 返回 base64 JPEG，1280px 图约 300-400KB，每次滑块变化都要经历：序列化 → IPC 传输 → 反序列化 → `<img>` 渲染。

### 5.2 本地文件协议替代 base64

`get_preview` 改为把处理结果写到临时文件，返回文件路径：

```
{data_dir}/preview_cache/
  {asset_id}_{settings_hash}.jpg
```

- `settings_hash`：`FilterSettings` 所有字段的快速哈希（`std::hash::DefaultHasher`）
- 相同参数命中同一文件，零开销
- 目录最多保留 **40 个文件**，超出时删最旧的（按 mtime 排序）
- 前端用 `convertFileSrc(path)` 加载

**IPC payload 变化**：

```
现在：PreviewResult { data: String(~400KB), mime: String }
改后：PreviewResult { path: String(~50B) }
```

### 5.3 前端防抖

滑块 `onChange` 加 **150ms debounce**，停止拖动后才发 `get_preview` 请求，避免请求堆积。

### 5.4 `PreviewResult` 类型变更

```typescript
// 现在
type PreviewResult = { data: string; mime: string }

// 改后
type PreviewResult = { path: string }
```

---

## 6. 资源隔离总览

```
tokio 异步运行时
├── import_directory (spawn_blocking)
├── exif_background_worker (spawn, exif_sem=4)
└── get_preview (spawn_blocking → preview_pool)

rayon 线程池
├── preview_pool     (cpu/2, 最少 2)  ← 预览色彩流水线
├── export_pool      (动态, 内存感知)  ← 批量导出
└── global pool                        ← 其他 rayon 调用

Semaphore
├── thumbnail_sem    (cpu/2, 最少 2)  ← 缩略图生成
└── exif_sem         (4, 固定)        ← EXIF 后台提取
```

---

## 7. 数据库 Migration

```sql
-- migration: add_exif_extracted_and_mtime
ALTER TABLE assets ADD COLUMN exif_extracted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN file_mtime INTEGER;  -- Unix timestamp seconds
```

---

## 8. 实现顺序建议

1. **模块二 L2 缓存文件名变更**（最小改动，立刻有收益）
2. **模块一两阶段导入**（用户感知最强）
3. **模块四预览文件协议**（滑块体验提升）
4. **模块三动态导出并发**（批量场景提升）
5. **模块二 L1 LRU 改造**（锦上添花）

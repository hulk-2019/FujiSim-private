# RAW 缩略图生成优化方案

## 背景

当前 RAW 缩略图生成由 `list_assets` 触发：查询结果中 `is_raw != 0 && cover_path IS NULL` 的资产会进入 `CoverQueue`，后台调用 `extract_cover_fast` 生成 `covers/project_{project_id}/{asset_id}.jpg`，写入后更新 `assets.cover_path` 并发送 `thumbnail:done`。

这个方案能避免导入阶段阻塞 UI，但存在几个风险：

- 分页、项目切换、列表刷新都会触发 `list_assets`，同一批 RAW 可能反复尝试入队。
- `CoverQueue::set_concurrency` 只更新 AtomicUsize，实际 `Semaphore` 容量不会变化，所以动态并发设置没有真实效果。
- 只在 cover 队列内部限流，EXIF worker、预览、tile、导出、白平衡等 CPU/IO 密集任务仍可能同时运行。
- 多个导入任务、多个列表视图刷新、多人/多窗口同时操作同一图库时，后台任务会叠加，CPU 使用率容易被拉满。
- 当前队列只记录进程内 `inflight`，重启后不知道哪些缩略图正在/曾经失败，无法做稳定恢复、退避和优先级调度。

## 目标

1. 缩略图生成不阻塞导入、列表滚动和预览交互。
2. 后台任务有全局 CPU/IO 预算，不因多个入口并发而叠加失控。
3. RAW cover 生成具备可恢复状态，避免重复生成、重复入队和失败风暴。
4. 优先生成用户当前可见区域的缩略图，后台再补齐图库。
5. 方案兼容后续多窗口、多项目、多用户共享图库的并发场景。

## 非目标

- 不在缩略图阶段生成完整 develop preview。
- 不把封面渲染效果做成滤镜最终效果；cover 只用于资产网格快速识别。
- 不在导入事务里同步解码 RAW。

## 当前实现评估

合理部分：

- cover 生成异步化，避免导入和列表查询卡住。
- `inflight` 可以避免同一进程内同一 asset 重复执行。
- `low_priority_work_can_start` 会避开正在交互预览的时间段。
- cover 路径按 project 分目录，便于后续按项目清理缓存。

需要优化部分：

- `list_assets` 作为触发源太宽，用户滚动/刷新会持续产生 enqueue 压力。
- `inflight` 是内存态，无法表达 `queued/running/failed/done`，也无法跨进程恢复。
- 队列没有优先级。当前可见图片和后台补齐图片被同等处理。
- 动态并发不可生效，`Semaphore` 初始化后无法通过当前 `set_concurrency` 改容量。
- 缺少全局 CPU 令牌。cover 队列、EXIF worker、导出、预览都可能各自“合法并发”，总和仍然过高。

## 总体设计

采用“持久任务表 + 全局资源预算 + 可见区域优先”的三层设计。

### 1. 缩略图任务持久化

新增 `asset_derivatives` 或 `thumbnail_jobs` 表，建议使用通用衍生物表：

```sql
CREATE TABLE IF NOT EXISTS asset_derivatives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  project_id INTEGER,
  kind TEXT NOT NULL,              -- cover, preview_base, tile 等
  status TEXT NOT NULL,            -- queued, running, done, failed
  path TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  locked_by TEXT,
  locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(asset_id, project_id, kind)
);
```

cover 文件路径仍可以保留在 `assets.cover_path` 作为列表快速读模型，但权威状态放到 `asset_derivatives`。这样后续 preview base、tile cache、AI masks 等都能复用同一套任务状态。

### 2. 全局后台资源预算

引入 `BackgroundResourceLimiter`，统一管理低优先级 CPU/IO 工作：

- `cpu_permits`: 默认 `max(1, logical_cpus / 4)`，上限建议 2。
- `io_permits`: 默认 2。
- `raw_decode_permits`: 默认 1，RAW 解码最重，必须单独限流。
- `low_priority_gate`: 当前已有的 `low_priority_work_can_start` 保留，用于交互预览期间暂停新任务。

所有低优先级任务启动前必须申请令牌：

- cover fast path：`io_permit + cpu_permit`，只提取 RAW 内嵌 JPEG，不占用重 RAW 解码令牌。
- cover LibRaw fallback：`raw_decode_permit + cpu_permit + io_permit`，只允许显式/可见优先任务触发。
- EXIF 提取：`io_permit`，必要时 `cpu_permit`
- preview base 后台预热：`raw_decode_permit + cpu_permit`
- 导出不走低优先级，但必须纳入 CPU/memory 预算，避免和 cover 叠加。

核心原则：不同入口、不同项目、不同用户/窗口同时触发任务时，最终都被同一个资源预算约束。

### 3. 队列从 fire-and-forget 改成 worker loop

当前 `enqueue` 每次创建一个后台 task 和 `JoinSet`。建议改成常驻 worker：

- `enqueue_cover_jobs(asset_ids, project_id, priority)` 只负责 upsert DB 任务。
- `CoverWorker` 常驻循环，从 DB 拉取 `queued/failed可重试` 的任务。
- worker 使用 `locked_by + locked_at` 抢占任务，防止多进程/多窗口重复执行。
- 执行成功后写文件、更新 `asset_derivatives`、同步 `assets.cover_path`。
- 执行失败后 `attempts += 1`，按指数退避重试。

任务拉取排序：

```sql
ORDER BY priority DESC, attempts ASC, created_at ASC
LIMIT ?
```

优先级建议：

- 当前 viewport 可见资产：100
- 当前项目首页/当前页资产：50
- 导入后后台补齐：10
- 全库维护任务：0

### 4. 可见区域优先

前端列表不应只依赖 `list_assets` 隐式触发缩略图生成。建议新增显式 IPC：

```ts
api.requestCovers(assetIds, projectId, priority)
```

触发时机：

- 虚拟列表可见范围变化时，对可见 assetIds 调用 `requestCovers(..., priority=100)`。
- `list_assets` 可以保留低优先级兜底，只 enqueue 当前页且 priority=10。
- 导入完成后只创建低优先级任务，不立即高并发解码。

这样用户看到哪里，哪里先生成；看不到的慢慢补。

### 5. RAW cover 生成策略

按成本从低到高选择路径：

1. 优先提取 RAW 内嵌 JPEG：`extract_thumb_rsraw` / TIFF IFD JPEG。
2. 使用 libvips `thumbnail_buffer` 直接从 JPEG buffer 生成封面长边小图，避免先完整解码到 16-bit RGB 再缩放。
3. 方向校正放在缩小后的 JPEG 上执行，降低旋转和重新编码成本。
4. 只有没有内嵌 JPEG 或质量太低时，才走 LibRaw 解码 fallback；批量导入默认不触发该 fallback。
5. LibRaw 解码生成 cover 时，不顺带生成大 preview base，除非该任务明确请求 `preview_base`。

原因：cover 是列表缩略图，不应该为每张 RAW 默认付出完整解码成本。完整 preview base 应由预览面板首次打开或后台低优先级预热触发。

### 6. 多人/多窗口并发控制

如果后续存在多窗口、多人共享同一个图库目录或同步数据库场景，需要做到：

- DB 任务锁：`locked_by = process_id/window_id/user_id`，`locked_at` 过期后可被抢占。
- 唯一键：`UNIQUE(asset_id, project_id, kind)`，从源头避免重复任务。
- 原子落盘：先写临时文件 `{asset_id}.jpg.tmp.{pid}`，成功后 rename 到目标路径。
- 成功幂等：如果目标 cover 已存在且可读，直接标记 `done`。
- 失败退避：连续失败的 RAW 不反复抢 CPU。

锁过期建议：

- cover 任务 2 分钟。
- RAW decode fallback 5 分钟。
- 启动时把过期 `running` 重置为 `queued`。

## 阶段计划

### 阶段 1：止血

- 修复 `CoverQueue::set_concurrency` 不生效问题，改为真正可调整的 permit 策略，或移除动态设置只暴露固定值。
- cover 队列申请 `state.io_sem` 或新的全局后台 limiter，确保 EXIF + cover 总并发不超过预算。
- `list_assets` 只 enqueue 当前返回页，且保留 `inflight` 去重。
- 对失败 asset 加内存级冷却时间，避免滚动时反复失败重试。

执行状态：

- 已完成：`CoverQueue::set_concurrency` 改为动态运行中的 slot 限制，不再依赖不可缩容的 `Semaphore`。
- 已完成：cover 任务启动前同时申请 cover slot 和 `state.io_sem`，与 EXIF 共享后台 IO/CPU 预算。
- 已完成：`inflight` 从单 asset 扩展为 `(project_id, asset_id)`，避免不同项目路径互相误判。
- 已完成：失败任务加入 60 秒内存冷却，降低坏文件或解析失败造成的重复 CPU 消耗。
- 待阶段 2 替换：内存态 `inflight/failed_until` 后续应迁移到持久任务表。

### 阶段 2：持久任务表

- 新增 `asset_derivatives` 表。
- `list_assets`/导入完成改为 upsert `cover` 任务，而不是直接 fire-and-forget。
- 实现常驻 `CoverWorker`，支持状态、锁、重试、优先级。
- 成功后继续维护 `assets.cover_path` 快速读模型。

执行状态：

- 已完成：新增 `asset_derivatives` 表，用 `(asset_id, project_id, kind)` 做唯一约束。
- 已完成：新增 `db::asset_derivatives`，支持 cover job 的 queued/running/done/failed 状态写入。
- 已完成：当前 `CoverQueue` 已在入队、运行、成功、失败时同步写入 `asset_derivatives`。
- 已完成：当前 fire-and-forget 批次调度已替换为 DB worker，worker 按 `priority DESC, attempts ASC, created_at ASC` 拉取 queued cover 任务。
- 已完成：启动迁移后会把残留 `running` cover 任务重置为 `queued`，避免上次异常退出后任务卡死。
- 已完成：实现 `locked_by/locked_at` 抢占锁，cover worker 使用数据库原子 claim，支持多进程/多用户同时连接同一图库时的严格去重。
- 已完成：`running` 任务超过 5 分钟未完成时会被视为过期锁，可被其他 worker 抢占。

### 阶段 3：可见区域优先

- 前端虚拟列表上报可见 assetIds。
- 新增 `request_covers(asset_ids, project_id, priority)` IPC。
- 当前可见任务 priority=100，后台补齐 priority=10。
- worker 每轮取最高优先级任务，避免后台任务抢占用户正在看的区域。

执行状态：

- 已完成：新增 `request_covers(asset_ids, project_id, priority)` IPC 和前端 `api.requestCovers` 包装。
- 已完成：`CoverQueue` 支持 `enqueue_with_priority`，`list_assets` 兜底仍使用 priority=10。
- 已完成：`AssetStrip` 虚拟列表接入可见范围上报，RAW 且缺 cover 的可见资产使用 priority=100。
- 已完成：DB worker 按 priority 拉取任务。

### 阶段 4：全局资源预算

- 实现 `BackgroundResourceLimiter`。
- cover、EXIF、preview base 预热全部走同一 limiter。
- 导出继续独立队列，但启动前检查 CPU/memory 预算。
- 预览交互期间暂停新低优先级任务，已有任务允许完成但不继续拉新任务。

执行状态：

- 已完成：新增 `BackgroundResourceLimiter`，统一管理低优先级 `cpu/io/raw_decode` 令牌。
- 已完成：cover worker fast path 启动任务前只申请 `cpu + io` 令牌，并继续受 `low_priority_work_can_start` 控制；重 RAW 解码预算保留给 preview base / fallback。
- 已完成：EXIF worker 改为通过 `BackgroundResourceLimiter` 申请 IO 令牌。
- 已完成：移除旧的 `io_sem`，避免后台任务混用两套预算。
- 已完成：`extract_cover_fast` 改为用 libvips `thumbnail_buffer` 从内嵌 JPEG 直接生成 128px cover，再对小图做 orientation 校正，减少批量导入时的 CPU 和内存放大。
- 待完成：preview base 后台预热尚未接入 limiter；当前 preview base 主要由预览面板按需生成。
- 待评估：导出已有 memory budget 和串行队列，是否还需要纳入 CPU permit 需要结合导出体验单独评估。

### 阶段 5：可观测性

- 增加队列状态 IPC：queued/running/done/failed 数量。
- 增加 tracing 字段：asset_id、project_id、kind、attempts、duration_ms、path_source。
- 前端只展示必要状态，不把所有任务进度刷到 React 高频状态。

## 验收标准

- 导入 1000 张 RAW 后，UI 可以立即滚动和切换预览。
- 连续滚动列表时，只优先生成可见区域 cover。
- 同时进行导入、预览调整、导出时，CPU 不因后台缩略图生成长期满载。
- 同一 asset/project/kind 不会出现重复生成任务。
- 应用重启后，未完成任务可以恢复，失败任务不会无限重试。
- 多窗口/多用户同时打开同一图库时，任务通过 DB 锁去重。

## 推荐先做的最小闭环

第一步不要直接大重构。建议先完成：

1. 让 cover 生成也申请全局后台资源令牌。
2. 增加失败冷却，避免失败任务被列表刷新反复触发。
3. 新增 `request_covers` IPC，让可见区域可以提高优先级。
4. 再引入持久任务表替换当前 `inflight` 内存态。

这样能先压住 CPU，再逐步把队列做成可恢复、可观测、可扩展的后台任务系统。

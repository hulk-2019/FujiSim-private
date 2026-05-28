# Preview-first 与 GPU 交互预览改造方案

日期：2026-05-28

## 背景

Lightroom、Pixelcake 这类软件在导入大量 RAW、快速切换图片、拖动滑块时看起来“秒开”，核心不是每次都完整解析 RAW，也不是每次滑块变化都重新生成一张图片文件。它们通常采用：

- RAW 内嵌 JPEG / 标准预览作为首帧。
- RAW develop 结果作为随后替换的权威渲染。
- 滑块拖动时用 GPU 对已有纹理做实时近似。
- 松手后再由权威后端管线生成稳定结果、直方图、1:1 tile。

当前项目已经具备一些基础：

- `cover` 已有 RAW 内嵌 JPEG 提取路径。
- `PreviewPanel` 已有 WebGL 交互层 `GpuInteractivePreviewCanvas`。
- 后端 `get_preview` 已区分 `interactive / settled / full / tile`。
- 后端已有 preview token、tile token、preview semaphore 和 histogram cancellation。
- 已有 `asset_derivatives` 表，可以扩展为 preview、embedded preview、tile 等衍生物状态管理。

但当前体验仍有几个根本限制：

- 快速切换图片时，画布首帧仍过度依赖后端 `get_preview` 或 disk preview base。
- RAW 内嵌大预览没有作为画布首帧的正式层级。
- 滑块拖动时，部分场景仍会触发后端 preview / histogram / tile，造成 CPU 叠加。
- WebGL 交互层和后端权威渲染之间的边界还不够明确，容易出现重复过渡、闪烁、二次渲染。
- preview base、embedded preview、cover、tile 的生命周期还没有统一到一个衍生物模型里。

## 目标

1. 快速切换 RAW 时，画布首帧尽量在 100ms 内显示。
2. 滑块拖动时，画面由前端 GPU 即时变化，不触发高频后端重渲染。
3. 松手后，后端 WGPU 生成权威 settled preview，并替换 WebGL 近似结果。
4. 放大到 100% 或更高时，只生成可视区域 tile，不整张全分辨率重算。
5. 后台任务统一调度，避免 cover、EXIF、preview、histogram、tile、export 同时把 CPU 拉满。
6. 保持单一权威管线：最终像素、导出、权威直方图、精确 develop 结果仍以后端 Rust/WGPU 为准。

## 非目标

- 不在前端实现完整 Lightroom develop engine。
- 不用 WebGL 替代 LibRaw demosaic。
- 不保证拖动过程中的 WebGL 近似与最终导出像素完全一致。
- 不在导入阶段同步生成所有 RAW 的完整 develop preview。

## 核心原则

### 1. 首帧 preview-first

切换图片时，第一目标是立刻给用户一张可识别、方向正确、比例正确的图。

优先级：

1. 已缓存的 settled preview。
2. 已缓存的 embedded preview / standard preview。
3. RAW 文件内嵌 JPEG 大预览。
4. 已缓存的 baseline TIFF / preview base。
5. 后端即时生成 settled preview。

这意味着快速切图时不应一上来就等待 RAW develop 权威结果。

### 2. 交互 GPU-first

滑块拖动期间，第一目标是视觉反馈即时变化。

拖动时：

- 前端 WebGL 使用当前画布纹理作为输入。
- 滑块值只更新 shader uniform。
- 不请求后端 `get_preview`。
- 不请求 histogram。
- 不请求 full preview。
- 不请求新 tile。
- 只通过 `mark_preview_interaction` 通知后端低优先级任务让路。

松手后：

- 后端只处理最后一次参数。
- 生成权威 settled preview。
- 计算权威 histogram。
- 必要时刷新 tile。

### 3. 后端 single source of truth

WebGL 只负责交互态近似，不拥有最终画质决策权。

后端 Rust/WGPU 负责：

- settled preview
- full preview
- tile preview
- histogram
- export
- 精确 LUT、曲线、颗粒、锐化、清晰度、去雾
- 后续镜头校正、几何校正、颜色范围、局部 mask

前端 WebGL 可近似：

- exposure
- brightness
- contrast
- white balance
- saturation / vibrance
- simple HSL
- simple tone segment
- simple split toning

前端 WebGL 不做权威实现：

- 精确 LUT
- 复杂 tone curve
- grain
- detail / sharpness
- dehaze
- lens correction
- geometry correction
- mask / local adjustment
- export output

## 目标架构

```text
RAW file
  |
  | import / scan
  v
Metadata + embedded preview descriptor
  |
  +--> cover cache: list/grid thumbnail
  |
  +--> embedded preview cache: canvas first frame
  |
  +--> preview base cache: backend develop working base
  |
  +--> tile cache: zoomed visible region

Canvas display
  |
  +--> first frame: embedded/standard preview
  |
  +--> drag frame: frontend WebGL approximation
  |
  +--> settled frame: backend WGPU authoritative preview
  |
  +--> zoom detail: backend WGPU tile overlay
```

## 衍生物模型

继续使用 `asset_derivatives` 作为统一任务和产物表。

建议扩展 `kind`：

- `cover`: 资产列表 80-160px 缩略图。
- `embedded_preview`: 画布首帧预览，来自 RAW 内嵌 JPEG，建议 1600-2560 长边。
- `preview_base`: 后端 develop 工作底图，16-bit TIFF / PNG / 内部格式。
- `settled_preview`: 当前 filter hash 的标准预览结果，可选磁盘缓存。
- `tile`: 当前 filter hash + zoom + region 的局部高精度结果。

建议字段补充：

```sql
ALTER TABLE asset_derivatives ADD COLUMN variant TEXT;
ALTER TABLE asset_derivatives ADD COLUMN width INTEGER;
ALTER TABLE asset_derivatives ADD COLUMN height INTEGER;
ALTER TABLE asset_derivatives ADD COLUMN source_mtime INTEGER;
ALTER TABLE asset_derivatives ADD COLUMN filter_hash TEXT;
ALTER TABLE asset_derivatives ADD COLUMN pipeline_version INTEGER DEFAULT 1;
```

说明：

- `variant` 用于区分 `embedded_2560`、`preview_base_1920`、`tile_1024` 等。
- `filter_hash` 只用于和 filter 相关的 settled preview / tile。
- `pipeline_version` 用于未来算法变化后整体失效旧缓存。
- `source_mtime` 用于检测源文件变化。若后续项目约束为只读导入，也可以弱化。

## 导入阶段策略

导入 500 张 RAW 时不要同步做完整 RAW develop。

导入阶段分成两个环：`登记环` 和 `预览衍生物环`。登记环必须快，预览衍生物环可以后台渐进完成。

### 登记环

导入命令同步等待的内容只包含：

1. 插入 `assets` 元数据。
2. 写入 `asset_project` 关联。
3. 获取文件大小、扩展名、文件名、基础 mtime。
4. 尽量读取轻量 EXIF。失败不阻塞导入。
5. 创建 `cover` / `embedded_preview` / `exif` 等后台任务。

登记环不做：

- LibRaw develop。
- preview base TIFF 生成。
- full resolution preview。
- histogram。
- tile。
- 大量 JPEG 重编码。

验收目标：

- 500 张 RAW 导入时，数据库登记应优先完成，UI 尽快出现 500 个资产占位。
- 导入完成事件表示“资产已入库”，不表示所有缩略图和预览都已生成。
- 用户可以立即滚动、筛选、切换图片，后台资源按可见区域优先补齐。

### 预览衍生物环

导入登记完成后，后台按优先级生成：

1. 当前可见 asset strip 的 `cover`，priority=100。
2. 当前 focused asset 的 `embedded_preview`，priority=100。
3. 当前 focused asset 的 `preview_base`，priority=90，但只在用户停留后触发。
4. 当前项目第一页/附近资产的 `cover`，priority=50。
5. 当前项目后台 `embedded_preview`，priority=20。
6. 当前项目后台 `cover`，priority=10。

后台任务必须受统一 limiter 控制：

- `cover`: `cpu + io`，只抽 RAW 内嵌 JPEG，小图缩放。
- `embedded_preview`: `cpu + io`，只抽 RAW 内嵌 JPEG，生成 2048/2560 长边预览。
- `preview_base`: `raw_decode + cpu`，重任务，默认只为 focused asset 按需生成。
- `exif`: `io`，必要时少量 `cpu`。

### 导入后的用户体验

理想体验不是等待所有任务完成，而是渐进出现：

```text
0-1s:
  资产记录进入列表，显示占位/文件名/基础信息

1-3s:
  可见区域 cover 逐步出现

切换到某张 RAW:
  若 embedded_preview 已存在，画布立即显示
  若不存在，优先生成当前 focused 的 embedded_preview

停留当前 RAW:
  后台生成 preview_base / settled preview
  完成后替换首帧预览
```

### 导入时是否生成 embedded preview

不建议在导入事务里同步生成全部 embedded preview。建议：

- 导入登记完成后立刻返回。
- 对当前可见和当前 focused 的 RAW 高优先级生成 embedded preview。
- 对其余 RAW 使用低优先级后台补齐。
- 若用户快速切到尚未生成 embedded preview 的图片，立即提升该资产任务优先级。

这样既能做到快速导入，也能做到用户看哪里哪里先“秒开”。

### embedded preview 处理方式

有两种选择：

#### 方案 A：导入时生成 embedded preview 文件

优点：

- 切换图片时直接读文件，逻辑简单。
- 前端 `convertFileSrc` 可直接展示。
- 便于跨会话复用。

缺点：

- 导入后会有一批后台 JPEG 写盘任务。
- 500 张 RAW 首次导入仍会占用一些 IO。

建议生成规格：

- `embedded_preview`: 长边 2048 或 2560。
- JPEG quality 85-90。
- 按项目目录存放：`embedded_previews/project_{id}/{asset_id}.jpg`。

#### 方案 B：只记录 RAW 内嵌 JPEG offset/size，切图时按需读取

优点：

- 导入阶段更轻。
- 不产生额外 preview 文件。

缺点：

- 需要可靠解析并持久化 offset/size。
- 不同 RAW/DNG 厂商兼容性复杂。
- WebView 不能直接加载 RAW 文件片段，需要 IPC 返回 bytes。

建议当前项目先采用方案 A。它更稳、更容易落地，且与现有 cover 生成模式一致。

## 快速切图流程

### 当前问题

当前 `usePreviewLoader` 更像是在寻找 baseline / 后端 preview，然后决定是否 loading。对于快速切图，应该先让画布显示可用首帧，再让权威渲染后台收敛。

### 目标流程

```text
focused asset changed
  |
  v
PreviewDisplayController selects first frame
  |
  +-- cached settled preview exists -> show
  |
  +-- embedded preview exists -> show immediately
  |
  +-- embedded preview missing -> request high priority embedded preview
  |
  +-- no display at all -> show skeleton only for first parse
  |
  v
Schedule backend settled preview after short idle
  |
  v
Replace display when authoritative preview returns
```

关键要求：

- 已有任意可显示图片时，不展示骨架屏。
- 骨架屏只用于首次没有任何可用 display 的 RAW。
- 切图时取消旧图后端请求。
- 旧图返回结果必须按 token / asset id 丢弃。
- 当前图已经有 embedded preview 时，不出现空白过渡。

## 滑块交互流程

### 拖动开始

```text
slider pointer down
  |
  v
filterInteraction = adjusting
  |
  v
mark_preview_interaction(1500ms)
  |
  v
freeze backend preview requests
  |
  v
WebGL layer visible
```

### 拖动中

```text
filter value changes
  |
  v
update WebGL uniforms
  |
  v
requestAnimationFrame draw
```

拖动中不做：

- `get_preview`
- `compute_histogram`
- full preview
- tile refinement
- JPEG encode
- temp file write
- preview base decode

### 拖动结束

```text
slider pointer up / debounce settled
  |
  v
compute latest filter hash
  |
  v
request backend settled preview
  |
  v
request histogram after settled preview is not busy
  |
  v
replace WebGL approximation with authoritative preview
```

关键点：

- 后端只处理最后一次 filter。
- 如果 settled preview 返回结果与当前 filter hash 不一致，丢弃。
- 替换时不要让画面先回到旧图再变新图。需要“handoff”状态保持 WebGL 画面直到权威结果 ready。

## 前端模块重构建议

当前 `PreviewPanel` 和 `usePreviewLoader` 中状态较多，建议按状态机拆分。

### 1. `usePreviewFirstFrame`

职责：

- 根据 focused asset 找首帧 display。
- 管理 embedded preview / baseline / settled preview 的优先级。
- 只决定“当前可显示什么”，不负责后端权威渲染。

输出：

```ts
type FirstFrameState = {
  display: PreviewImage | null;
  displaySource: "settled" | "embedded" | "baseline" | "original" | "none";
  needsInitialSkeleton: boolean;
  needsEmbeddedPreview: boolean;
};
```

### 2. `useInteractiveGpuPreview`

职责：

- 判断当前 filter 是否可 GPU 近似。
- 拖动时更新 uniforms。
- 控制 WebGL layer 可见性。
- 管理 WebGL 到后端 settled preview 的 handoff。

输出：

```ts
type InteractiveGpuState = {
  enabled: boolean;
  visible: boolean;
  holdingApproximation: boolean;
};
```

### 3. `useAuthoritativePreview`

职责：

- 只在非拖动状态请求后端 settled/full preview。
- coalesce 请求，只保留最新。
- 管理 token、busy、cancelled、filter hash。

输出：

```ts
type AuthoritativePreviewState = {
  preview: AssetPreviewImage | null;
  loading: boolean;
  mode: PreviewMode | null;
  error: string | null;
};
```

### 4. `usePreviewDisplayState`

职责：

- 合成最终 UI 展示状态。
- 决定 img/canvas/tile/skeleton/label 是否显示。

输出：

```ts
type PreviewDisplayState = {
  baseSrc: string | null;
  overlayGpu: boolean;
  overlayTiles: boolean;
  showSkeleton: boolean;
  showRenderingLabel: boolean;
};
```

## 后端 IPC 设计

### 新增 `get_embedded_preview`

```rust
get_embedded_preview(asset_id, project_id) -> Option<PreviewResult>
```

行为：

- 如果 `embedded_preview` 文件已存在，直接返回 path/size。
- 如果不存在，返回 `None`，由前端发起 `request_preview_derivative` 或后端自动排队。

### 新增 `request_preview_derivatives`

```rust
request_preview_derivatives(asset_ids, project_id, kinds, priority)
```

支持 kind：

- `cover`
- `embedded_preview`
- `preview_base`

用途：

- 可见 asset strip 请求 cover。
- 当前 focused asset 请求 embedded preview / preview base。
- 后台低优先级补齐。

### 调整 `get_preview`

保留当前 `interactive / settled / full / tile`，但语义收紧：

- `interactive`: 只作为没有 WebGL 时的降级，不在正常滑块拖动中高频调用。
- `settled`: 松手后权威标准预览。
- `full`: 显式请求，不随普通滑块释放立即触发。
- `tile`: zoom idle 后可视区域 refinement。

## 后端任务调度

优先级建议：

1. 当前 focused asset 的 settled preview。
2. 当前 focused asset 的 embedded preview。
3. 当前 focused asset 的 histogram。
4. 当前 zoom viewport tile。
5. 可见 asset strip cover。
6. 当前项目后台 embedded preview。
7. 当前项目后台 cover。
8. EXIF / 非可见维护任务。
9. export。

说明：

- export 是否比后台任务高取决于产品定位。如果用户主动导出，应给 export 明确进度，但不能抢占当前编辑交互。
- histogram 不应在拖动中运行。
- tile 不应在拖动中运行。
- cover 不应在 preview active / interaction active 时启动新任务。

## 缓存目录建议

```text
data_dir/
  covers/
    project_{id}/
      {asset_id}.jpg

  embedded_previews/
    project_{id}/
      {asset_id}.jpg

  raw_originals/
    project_{id}/
      {asset_id}_baseline.tif

  preview_cache/
    project_{id}/
      {asset_id}/
        settled_{filter_hash}_{pipeline_version}.jpg

  tiles/
    project_{id}/
      {asset_id}/
        {filter_hash}_{zoom}_{x}_{y}_{pipeline_version}.jpg
```

路径是否写入 SQLite：

- `cover_path` 可以继续留在 `assets` 作为列表快速读模型。
- `embedded_preview`、`preview_base`、`tile` 建议写入 `asset_derivatives`。
- 对于 filter 相关结果，不建议在 `assets` 表加列，应该只进 `asset_derivatives`。

## CPU 控制策略

### 拖动期间

- 后端 preview 不启动。
- histogram 不启动。
- tile 不启动。
- cover / EXIF 不启动新任务。
- export 不启动新 batch，已运行任务可继续。

### 松手后 300-500ms

- 发起 settled preview。
- preview 成功后发起 histogram。
- zoom idle 后发起 tile。

### 快速切图期间

- 每次 focused asset 变化递增 token。
- 旧 preview / histogram / tile 返回后全部丢弃。
- 后端任务在 CPU 密集节点检查 token，过期提前退出。
- 只对当前 focused asset 保留最高优先级。

## 画布展示策略

### 不允许出现的过渡

- 有 embedded/baseline/旧 settled 图时显示骨架屏。
- WebGL 拖动结束后先回到旧图，再跳到新图。
- 切图时空白一下再显示图片。
- “渲染中...”连续闪两次。

### 允许出现的过渡

- 首帧 embedded preview 后，权威 develop preview 替换时轻微色彩变化。
- 放大后 tile 局部逐步清晰。
- 没有任何预览资源的 RAW 首次解析时显示比例正确的骨架屏。

## 渐进实施计划

### 阶段 1：首帧 preview-first

目标：快速切图时先显示 embedded preview，不等待 develop。

任务：

- 新增 `embedded_previews/project_{id}/{asset_id}.jpg` 生成路径。
- 新增 `get_embedded_preview` IPC。
- 新增 `request_preview_derivatives` 或扩展现有 cover queue 支持 `embedded_preview`。
- `usePreviewLoader` 拆出 `usePreviewFirstFrame`。
- `PreviewPanel` 首帧显示优先级改为 settled > embedded > baseline > skeleton。

验收：

- RAW 首次切换有 embedded preview 时不出现空白。
- 快速切换多张 RAW，画布能立即显示每张图的首帧。
- 骨架屏只在当前 asset 没有任何可显示资源时出现。

### 阶段 2：拖动期间后端静默

目标：滑块拖动只走 WebGL。

任务：

- 明确 `isAdjustingFilter` 期间禁止 `get_preview`。
- histogram hook 在拖动期间直接暂停。
- tile hook 在拖动期间直接暂停。
- `mark_preview_interaction` 保持后台任务让路。
- `GpuInteractivePreviewCanvas` 输入纹理稳定，不因后端 loading 反复重建。

验收：

- 连续拖动曝光/白平衡/HSL，CPU 不出现持续 100%+。
- “渲染中...”拖动期间不反复出现。
- 画面不会先变亮再回暗再变亮。

### 阶段 3：权威结果 handoff

目标：WebGL 近似到后端 settled preview 平滑交接。

任务：

- 引入 `filter_hash`。
- 后端 `PreviewResult` 返回 `filter_hash`。
- 前端只接受匹配当前 focused asset + filter hash 的结果。
- WebGL approximation 保持到权威结果 decoded ready。
- img onLoad 后再隐藏 WebGL overlay。

验收：

- 松手后最多一次“渲染中...”。
- 不出现旧图/旧效果闪回。
- reset / preset / slider release 都不会双次过渡。

### 阶段 4：tile refinement 收敛

目标：放大后只更新可视区域。

任务：

- tile 请求只在 zoom idle + filter settled 后启动。
- tile cache key 增加 filter hash / pipeline version。
- tile 使用低并发，当前中心优先。
- 拖动滑块时清理或隐藏过期 tile。

验收：

- 100% 放大时不整张全分辨率重算。
- 调整滑块后不会立即触发大量 tile。
- 停止交互后可视区域逐步清晰。

### 阶段 5：统一 derivative worker

目标：cover、embedded preview、preview base 共用任务表和资源预算。

任务：

- 扩展 `asset_derivatives.kind`。
- worker 支持 `cover / embedded_preview / preview_base`。
- 不同 kind 使用不同资源令牌。
- 加入 attempts、lock timeout、failure cooldown。
- 增加队列状态 tracing。

验收：

- 导入 500 张 RAW 后 UI 可立即操作。
- 后台任务不会长期占满 CPU。
- 当前可见/当前 focused 的资源优先生成。

## 风险与取舍

### embedded preview 与 develop preview 色彩不一致

这是正常现象。相机内嵌 JPEG 经过厂商风格处理，develop preview 是本应用管线结果。解决方式不是强行匹配，而是：

- 首帧只作为过渡。
- settled preview 尽快替换。
- 替换时保持平滑，不闪白/不回旧图。

### WebGL 近似与最终结果不一致

可接受，但需要边界清晰：

- 可近似的参数拖动即时反馈。
- 不可近似的参数拖动时保留当前画面或做轻量提示。
- 松手后以后端权威结果为准。

### embedded preview 文件增加磁盘占用

可以通过策略控制：

- 只为当前项目生成。
- 只为最近访问生成。
- LRU 清理。
- 长边限制到 2048/2560。

### 多任务调度复杂度上升

用 `asset_derivatives` 统一状态可以抵消复杂度。不要让每个功能各自维护队列。

## 推荐改造顺序

建议按以下顺序实施：

1. 阶段 1：首帧 preview-first。
2. 阶段 2：拖动期间后端静默。
3. 阶段 3：权威结果 handoff。
4. 阶段 5：统一 derivative worker。
5. 阶段 4：tile refinement 收敛。

原因：

- 首帧和拖动体验是用户最敏感的部分。
- handoff 能直接解决闪烁、二次过渡、“渲染中...”重复。
- worker 统一化适合作为后续稳定性改造。
- tile 可以在基础交互稳定后继续细化。

## 最小可验证闭环

第一轮只做：

1. 生成并读取 `embedded_preview`。
2. 切图时优先显示 `embedded_preview`。
3. 滑块拖动期间完全禁止后端 preview/histogram/tile。
4. 松手后只请求一次 settled preview。
5. img onLoad 后再隐藏 WebGL overlay。

这五件事完成后，应该能明显改善：

- 快速切图空白/骨架屏问题。
- 滑块拖动 CPU 飙升问题。
- 渲染中重复出现问题。
- 效果从暗到亮后又回暗再变亮的问题。

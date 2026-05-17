# 素材列表虚拟滚动设计文档

**日期：** 2026-05-17  
**状态：** 待实现

## 背景

左侧素材列表（`AssetGrid`）当前一次性渲染全部 `assets`，store 硬限 `limit: 100`。随着图库增大，DOM 节点数量线性增长，滚动性能下降。目标是支持万级素材的流畅浏览。

## 方案

虚拟化渲染（`@tanstack/react-virtual`）+ 后端分页加载，两层解耦。

---

## 后端变更

### `list_assets` 响应格式变更

**当前：** 返回 `Asset[]`  
**变更后：** 返回 `{ items: Asset[], total: i64 }`

一次响应同时返回数据和总数，省去额外 count 查询。

涉及文件：
- `src-tauri/src/db/assets.rs` — 新增 `ListAssetsResult` 结构体，`list` 函数返回类型变更
- `src-tauri/src/ipc.rs` — `list_assets` command 返回类型同步更新

---

## 前端变更

### 常量

```
PAGE_SIZE = 60  // 2列 × 30行，必须是2的倍数
```

### Store 变更（`src/store.ts`）

**类型变更：**
- `assets: Asset[]` → `assets: (Asset | undefined)[]`（稀疏数组，`length === totalCount`）
- 新增 `totalCount: number`（初始 0）
- 新增 `isLoadingPage: Set<number>`（存储正在加载的 offset，防重复请求）

**新增 action：**
- `loadPage(offset: number): Promise<void>`
  - 若 `isLoadingPage.has(offset)` 则直接返回
  - 调用 `api.listAssets({ ...query, limit: PAGE_SIZE, offset })`
  - 将返回的 items 写入 `assets[offset + i]`
  - 更新 `totalCount`（用响应里的 `total`）

**变更 action：**
- `refreshAssets`：重置 `assets` 为长度 0 的空数组、`totalCount = 0`、`isLoadingPage` 清空，然后调用 `loadPage(0)` 拉第一页（第一页响应会更新 `totalCount`，数组自动扩展）
- `selectAll`：选中 `assets` 中所有非 `undefined` 槽位的 ID（已加载数据的全选）
- `selectRange`：按 index 范围 `[lo, hi]` 遍历，跳过 `undefined` 槽位，只把有数据的 ID 加入 `selectedIds`

**全选降级行为：**  
新数据加载后，`selectedIds.size < 已加载非undefined数量`，现有的 `allSelected` / `partiallySelected` 计算逻辑自然降级为半选，无需额外处理。

### API 变更（`src/api.ts`）

`listAssets` 返回类型从 `Asset[]` 改为 `{ items: Asset[]; total: number }`。

### AssetGrid 变更（`src/components/AssetGrid.tsx`）

**Grid 组件重写：**

```
useVirtualizer({
  count: Math.ceil(totalCount / 2),   // 总行数
  getScrollElement: () => scrollRef.current,
  estimateSize: () => 180,            // 行高估算（px），含 gap
  overscan: 3,                        // 上下各预渲染3行
})
```

**可见行变化时触发加载：**  
在 virtualizer 的 `onChange` 或渲染循环中，对每个虚拟行检查 `assets[rowIndex * 2]` 和 `assets[rowIndex * 2 + 1]`，若为 `undefined` 则计算对应 offset（`Math.floor(rowIndex * 2 / PAGE_SIZE) * PAGE_SIZE`）并调用 `loadPage`。

**骨架屏：**  
槽位为 `undefined` 时渲染占位卡片（灰色方块，与 Thumb 等高），避免布局跳动。

**布局：**  
外层容器改为固定高度 + `overflow: hidden`（由 virtualizer 接管滚动），内层用 `position: relative` + `height: totalSize`，每个虚拟行用 `position: absolute; top: virtualRow.start`。每行内部仍用 flex 排列2个 Thumb，保持现有卡片样式不变。

---

## 不变的部分

- `Thumb` 组件内部逻辑完全不变
- 筛选/排序变更时，`setQuery` 触发 `refreshAssets`，重置并重新加载，行为与现在一致
- 选择、重命名、删除、移动相册等操作逻辑不变

---

## 边界情况

| 场景 | 处理 |
|------|------|
| 快速滚动跳过多页 | `isLoadingPage` 防重，每页独立请求，乱序返回也能正确写入对应槽位 |
| 筛选条件变更 | `refreshAssets` 重置全部状态，重新从 offset=0 开始 |
| 总数为奇数 | 最后一行只有1个 Thumb，右侧空白，正常 |
| 删除/导入后刷新 | 调用 `refreshAssets` 完整重置，不做增量更新 |

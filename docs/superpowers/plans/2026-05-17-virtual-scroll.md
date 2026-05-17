# Virtual Scroll Asset Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为左侧素材列表添加虚拟滚动 + 后端分页，支持万级素材流畅浏览。

**Architecture:** 后端 `list_assets` 响应改为 `{ items, total }` 格式；前端 store 改用稀疏数组 + `loadPage(offset)` 按需拉取；`AssetGrid` 用 `@tanstack/react-virtual` 按行虚拟化，可见行变化时触发加载，未加载槽位显示骨架屏。

**Tech Stack:** Rust/sqlx (后端), @tanstack/react-virtual (前端虚拟化), zustand (状态管理), React 18, TypeScript

---

## File Map

| 文件 | 变更类型 | 职责 |
|------|----------|------|
| `src-tauri/src/db/assets.rs` | Modify | 新增 `ListAssetsResult` 结构体，`list` 函数返回 `(items, total)` |
| `src-tauri/src/ipc.rs` | Modify | `list_assets` command 返回类型改为 `ListAssetsResult` |
| `src/api.ts` | Modify | `listAssets` 返回类型改为 `{ items: Asset[]; total: number }` |
| `src/store.ts` | Modify | 稀疏数组、`totalCount`、`isLoadingPage`、`loadPage`、`refreshAssets`、`selectAll`、`selectRange` |
| `src/components/AssetGrid.tsx` | Modify | `Grid` 组件改用 `useVirtualizer` 行虚拟化，骨架屏占位 |

---

## Task 1: 后端 — `list_assets` 返回 `{ items, total }`

**Files:**
- Modify: `src-tauri/src/db/assets.rs`
- Modify: `src-tauri/src/ipc.rs`

- [ ] **Step 1: 在 `assets.rs` 末尾添加 `ListAssetsResult` 结构体**

在 `src-tauri/src/db/assets.rs` 的 `list` 函数之前（约第 155 行，`pub async fn list` 上方）添加：

```rust
#[derive(Debug, Serialize)]
pub struct ListAssetsResult {
    pub items: Vec<Asset>,
    pub total: i64,
}
```

- [ ] **Step 2: 修改 `list` 函数，同时查询 total**

将 `src-tauri/src/db/assets.rs` 中的 `list` 函数签名改为：

```rust
pub async fn list(pool: &SqlitePool, q: &AssetQuery) -> Result<ListAssetsResult> {
```

函数内部，在构建完 `where_clauses` 和 `binds` 之后（ORDER BY 之前）、拼接 `LIMIT/OFFSET` 之前，插入 count 查询。具体做法是把现有函数结尾的 `let mut query = ...; Ok(query.fetch_all(pool).await?)` 替换为：

```rust
    // count query：与 items query 共享相同的 JOIN + WHERE，只改 SELECT 部分
    let join_where = if !where_clauses.is_empty() {
        let join_part = if q.album_id.is_some() {
            " INNER JOIN album_assets aa ON aa.asset_id = a.id"
        } else {
            ""
        };
        format!("SELECT COUNT(*) FROM assets a{} WHERE {}", join_part, where_clauses.join(" AND "))
    } else {
        "SELECT COUNT(*) FROM assets a".to_string()
    };
    let mut count_query = sqlx::query_as::<_, (i64,)>(&join_where);
    for b in &binds {
        count_query = match b {
            Bind::I64(v) => count_query.bind(*v),
            Bind::Str(v) => count_query.bind(v.clone()),
        };
    }
    let (total,) = count_query.fetch_one(pool).await?;

    let limit = q.limit.unwrap_or(500);
    let offset = q.offset.unwrap_or(0);
    sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

    let mut items_query = sqlx::query_as::<_, Asset>(&sql);
    for b in binds {
        items_query = match b {
            Bind::I64(v) => items_query.bind(v),
            Bind::Str(v) => items_query.bind(v),
        };
    }
    let items = items_query.fetch_all(pool).await?;
    Ok(ListAssetsResult { items, total })
```

注意：原来在这之前已有的 `let limit = ...; let offset = ...; sql.push_str(...)` 这三行需要删除（已移入上方代码块）。

- [ ] **Step 3: 更新 `ipc.rs` 中的 `list_assets` command**

将 `src-tauri/src/ipc.rs` 中的：

```rust
pub async fn list_assets(
    state: State<'_, SharedState>,
    query: assets::AssetQuery,
) -> Result<Vec<assets::Asset>> {
    assets::list(&state.pool, &query).await
}
```

改为：

```rust
pub async fn list_assets(
    state: State<'_, SharedState>,
    query: assets::AssetQuery,
) -> Result<assets::ListAssetsResult> {
    assets::list(&state.pool, &query).await
}
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

期望：无 error，只有可能的 warning。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/assets.rs src-tauri/src/ipc.rs
git commit -m "feat(backend): list_assets returns { items, total }"
```

---

## Task 2: 前端 API 层更新

**Files:**
- Modify: `src/api.ts`

- [ ] **Step 1: 修改 `listAssets` 返回类型**

在 `src/api.ts` 中，将：

```typescript
listAssets: (query: AssetQuery = {}) => invoke<Asset[]>("list_assets", { query }),
```

改为：

```typescript
listAssets: (query: AssetQuery = {}) =>
  invoke<{ items: Asset[]; total: number }>("list_assets", { query }),
```

- [ ] **Step 2: TypeScript 编译检查**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -40
```

期望：此时会有 store.ts 的类型错误（因为 store 还在用旧的 `Asset[]`），这是正常的，Task 3 会修复。

- [ ] **Step 3: Commit**

```bash
git add src/api.ts
git commit -m "feat(api): listAssets returns { items, total }"
```

---

## Task 3: Store — 稀疏数组 + 分页加载

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: 更新 `AppState` 类型定义**

在 `src/store.ts` 的 `type AppState` 中，将：

```typescript
assets: Asset[];
loading: boolean;
```

改为：

```typescript
assets: (Asset | undefined)[];
totalCount: number;
isLoadingPage: Set<number>;
loading: boolean;
```

并在 actions 区域新增：

```typescript
loadPage: (offset: number) => Promise<void>;
```

- [ ] **Step 2: 更新初始状态**

在初始状态对象中，将：

```typescript
assets: [],
```

改为：

```typescript
assets: [],
totalCount: 0,
isLoadingPage: new Set<number>(),
```

- [ ] **Step 3: 实现 `loadPage` action**

在 `refreshAssets` action 之后添加 `loadPage`：

```typescript
loadPage: async (offset: number) => {
  const { isLoadingPage, query } = get();
  if (isLoadingPage.has(offset)) return;
  const next = new Set(isLoadingPage);
  next.add(offset);
  set({ isLoadingPage: next });
  try {
    const { items, total } = await api.listAssets({ ...query, limit: 60, offset });
    const current = get().assets;
    // 扩展稀疏数组到 total 长度
    const arr = current.length === total ? [...current] : Array(total).fill(undefined);
    // 复制已有数据
    if (current.length !== total) {
      for (let i = 0; i < current.length && i < total; i++) {
        arr[i] = current[i];
      }
    }
    items.forEach((item, i) => {
      arr[offset + i] = item;
    });
    const loading = get().isLoadingPage;
    const nextLoading = new Set(loading);
    nextLoading.delete(offset);
    set({ assets: arr, totalCount: total, isLoadingPage: nextLoading });
  } catch (e) {
    console.error("loadPage failed", e);
    const loading = get().isLoadingPage;
    const nextLoading = new Set(loading);
    nextLoading.delete(offset);
    set({ isLoadingPage: nextLoading });
  }
},
```

- [ ] **Step 4: 重写 `refreshAssets`**

将现有 `refreshAssets` 替换为：

```typescript
refreshAssets: async () => {
  set({ loading: true, assets: [], totalCount: 0, isLoadingPage: new Set() });
  try {
    const { items, total } = await api.listAssets({ ...get().query, limit: 60, offset: 0 });
    const arr: (Asset | undefined)[] = Array(total).fill(undefined);
    items.forEach((item, i) => { arr[i] = item; });

    // 收敛 selectedIds：剔除已不在结果集中的 id（只检查已加载的第一页）
    const validIds = new Set(items.map((a) => a.id));
    const prevSelected = get().selectedIds;
    let nextSelected = prevSelected;
    if (prevSelected.size > 0) {
      const filtered = new Set<number>();
      for (const id of prevSelected) {
        if (validIds.has(id)) filtered.add(id);
      }
      if (filtered.size !== prevSelected.size) nextSelected = filtered;
    }

    // 收敛 focusedId
    const focused = get().focusedId;
    let nextFocused: number | null = focused;
    if (focused == null || !validIds.has(focused)) {
      nextFocused =
        nextSelected.size > 0
          ? (nextSelected.values().next().value ?? null)
          : (items[0]?.id ?? null);
    }

    set({
      assets: arr,
      totalCount: total,
      isLoadingPage: new Set(),
      loading: false,
      selectedIds: nextSelected,
      focusedId: nextFocused,
    });

    // 后台预生成 RAW 缩略图
    const rawIds = items.filter((a) => Boolean(a.is_raw)).map((a) => a.id);
    if (rawIds.length > 0) {
      setTimeout(() => api.generateThumbnails(rawIds).catch(() => {}), 600);
    }
  } catch (e) {
    console.error("refreshAssets failed", e);
    set({ loading: false });
  }
},
```

- [ ] **Step 5: 更新 `selectAll` 和 `selectRange`**

将：

```typescript
selectAll: () => set({ selectedIds: new Set(get().assets.map((a) => a.id)) }),
```

改为：

```typescript
selectAll: () => set({
  selectedIds: new Set(
    get().assets.filter((a): a is Asset => a !== undefined).map((a) => a.id)
  ),
}),
```

将 `selectRange` 改为：

```typescript
selectRange: (id) => {
  const { assets, focusedId } = get();
  if (!focusedId) {
    get().toggleSelect(id, false);
    return;
  }
  const a = assets.findIndex((x) => x?.id === focusedId);
  const b = assets.findIndex((x) => x?.id === id);
  if (a < 0 || b < 0) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const cur = new Set(get().selectedIds);
  for (let i = lo; i <= hi; i++) {
    const asset = assets[i];
    if (asset !== undefined) cur.add(asset.id);
  }
  set({ selectedIds: cur });
},
```

- [ ] **Step 6: TypeScript 编译检查**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -40
```

期望：store.ts 的错误消失，可能还有 AssetGrid.tsx 的错误（Task 4 修复）。

- [ ] **Step 7: Commit**

```bash
git add src/store.ts
git commit -m "feat(store): sparse array + loadPage for virtual scroll"
```

---

## Task 4: 安装 @tanstack/react-virtual

**Files:**
- Modify: `package.json` (pnpm 自动更新)

- [ ] **Step 1: 安装依赖**

```bash
cd /Users/ry2019/private/FujiSim && pnpm add @tanstack/react-virtual
```

期望：`package.json` 中出现 `"@tanstack/react-virtual": "^3.x.x"`。

- [ ] **Step 2: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @tanstack/react-virtual"
```

---

## Task 5: AssetGrid — 虚拟化 Grid 组件

**Files:**
- Modify: `src/components/AssetGrid.tsx`

- [ ] **Step 1: 更新 import 和常量**

在 `src/components/AssetGrid.tsx` 顶部，现有 import 之后添加：

```typescript
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Asset } from "@/types";

const PAGE_SIZE = 60;
const COLS = 2;
const ROW_HEIGHT = 220; // px，含 gap；与卡片实际高度对齐后可调整
```

- [ ] **Step 2: 更新 AssetGrid 从 store 读取新字段**

在 `AssetGrid` 函数中，将：

```typescript
const assets = useStore((s) => s.assets);
const loading = useStore((s) => s.loading);
```

改为：

```typescript
const assets = useStore((s) => s.assets);
const totalCount = useStore((s) => s.totalCount);
const loading = useStore((s) => s.loading);
const loadPage = useStore((s) => s.loadPage);
```

- [ ] **Step 3: 更新 loading/empty 判断**

将：

```typescript
if (loading && assets.length === 0) {
```

改为：

```typescript
if (loading && totalCount === 0) {
```

将：

```typescript
if (assets.length === 0) {
```

改为：

```typescript
if (!loading && totalCount === 0) {
```

- [ ] **Step 4: 更新 toolbar 中的 total 显示和 selectAll 判断**

将：

```typescript
const allSelected = selectedIds.size > 0 && selectedIds.size === assets.length;
const partiallySelected = selectedIds.size > 0 && !allSelected;
```

改为：

```typescript
const loadedCount = assets.filter((a) => a !== undefined).length;
const allSelected = selectedIds.size > 0 && selectedIds.size === loadedCount;
const partiallySelected = selectedIds.size > 0 && !allSelected;
```

将 toolbar 中的 total 显示：

```typescript
<span className="text-zinc-500 ml-1">{t("assetGrid.total", { count: assets.length })}</span>
```

改为：

```typescript
<span className="text-zinc-500 ml-1">{t("assetGrid.total", { count: totalCount })}</span>
```

- [ ] **Step 5: 重写 Grid 组件**

将现有 `Grid` 函数完整替换为：

```typescript
function Grid({
  assets,
  totalCount,
  loadPage,
  selectedIds,
  focusedId,
  onSelect,
  onFocus,
  onToggleCheckbox,
  onRatingChange,
  onRenamed,
}: {
  assets: (Asset | undefined)[];
  totalCount: number;
  loadPage: (offset: number) => void;
  selectedIds: Set<number>;
  focusedId: number | null;
  onSelect: (a: Asset, e: React.MouseEvent) => void;
  onFocus: (a: Asset) => void;
  onToggleCheckbox: (a: Asset) => void;
  onRatingChange: (a: Asset, v: number) => void;
  onRenamed: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowCount = Math.ceil(totalCount / COLS);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 3,
  });

  // 可见行变化时触发加载
  useEffect(() => {
    const virtualItems = virtualizer.getVirtualItems();
    const neededOffsets = new Set<number>();
    for (const vRow of virtualItems) {
      for (let col = 0; col < COLS; col++) {
        const idx = vRow.index * COLS + col;
        if (idx < totalCount && assets[idx] === undefined) {
          const pageOffset = Math.floor(idx / PAGE_SIZE) * PAGE_SIZE;
          neededOffsets.add(pageOffset);
        }
      }
    }
    neededOffsets.forEach((offset) => loadPage(offset));
  }, [virtualizer.getVirtualItems(), assets, totalCount, loadPage]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto">
      <div
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        className="px-4 py-4"
      >
        {virtualizer.getVirtualItems().map((vRow) => (
          <div
            key={vRow.key}
            style={{
              position: "absolute",
              top: vRow.start + 16, // 16px = py-4
              left: 16,
              right: 16,
              height: vRow.size - 12, // 12px gap
            }}
            className="flex gap-3"
          >
            {Array.from({ length: COLS }).map((_, col) => {
              const idx = vRow.index * COLS + col;
              if (idx >= totalCount) return <div key={col} className="flex-1" />;
              const asset = assets[idx];
              if (!asset) {
                return (
                  <div
                    key={col}
                    className="flex-1 rounded-md bg-zinc-900/50 border border-zinc-800/80 animate-pulse"
                  />
                );
              }
              return (
                <div key={asset.id} className="flex-1 min-w-0">
                  <Thumb
                    asset={asset}
                    selected={selectedIds.has(asset.id)}
                    focused={focusedId === asset.id}
                    onClick={(e) => {
                      onSelect(asset, e);
                      onFocus(asset);
                    }}
                    onToggleCheckbox={() => onToggleCheckbox(asset)}
                    onRatingChange={(v) => onRatingChange(asset, v)}
                    onRenamed={onRenamed}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: 在 AssetGrid 中给 Grid 传新 props**

将 `<Grid ... />` 调用更新为：

```typescript
<Grid
  assets={assets}
  totalCount={totalCount}
  loadPage={loadPage}
  selectedIds={selectedIds}
  focusedId={focusedId}
  onSelect={(asset, e) => {
    if (e.shiftKey) selectRange(asset.id);
    else toggleSelect(asset.id, e.metaKey || e.ctrlKey);
  }}
  onFocus={(asset) => focusAsset(asset.id)}
  onToggleCheckbox={(asset) => toggleSelect(asset.id, true)}
  onRatingChange={async (asset, v) => {
    await api.setRating(asset.id, v);
    await refreshAssets();
  }}
  onRenamed={refreshAssets}
/>
```

- [ ] **Step 7: 在 Grid 函数顶部添加 useRef import**

确认 `AssetGrid.tsx` 顶部的 import 包含 `useRef` 和 `useEffect`：

```typescript
import { useMemo, useRef, useEffect, useState } from "react";
```

- [ ] **Step 8: TypeScript 编译检查**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -40
```

期望：0 errors。

- [ ] **Step 9: Commit**

```bash
git add src/components/AssetGrid.tsx
git commit -m "feat(ui): virtualize asset grid with @tanstack/react-virtual"
```

---

## Task 6: 验证与收尾

- [ ] **Step 1: 启动开发服务器**

```bash
cd /Users/ry2019/private/FujiSim && pnpm tauri dev 2>&1 &
```

- [ ] **Step 2: 手动验证清单**

在应用中确认：
1. 素材列表正常显示，2列网格布局不变
2. 滚动时新数据自动加载（骨架屏 → 真实卡片）
3. 快速滚动到底部不崩溃，不重复请求同一页
4. 筛选条件变更后列表正确重置
5. Shift+点击范围选择正常
6. 全选按钮选中已加载数据，加载新数据后变为半选状态
7. 删除/导入后刷新列表正常

- [ ] **Step 3: 最终 Commit（如有遗漏修复）**

```bash
git add -p
git commit -m "fix: virtual scroll edge case fixes"
```

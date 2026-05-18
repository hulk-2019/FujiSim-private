# 文件夹 UI 细节优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三处 UI 细节优化：移除刷新按钮并加重置筛选按钮、文件夹列表改为卡片风格、返回文件夹列表时清空画布选中状态。

**Architecture:** 纯前端改动，无后端变更。Sidebar 移除 RefreshCw 按钮并在筛选区右侧加 RotateCcw 重置按钮；FolderList 行列表改为 2 列 grid 卡片；store.exitFolder 追加 clearSelection + focusAsset(null)。

**Tech Stack:** React 18 + TypeScript，zustand，lucide-react，shadcn/ui，Tailwind CSS

---

## File Map

| 文件 | 变更类型 | 职责 |
|------|----------|------|
| `src/components/Sidebar.tsx` | Modify | 移除刷新按钮，加重置筛选按钮 |
| `src/components/FolderList.tsx` | Modify | 行列表改为 2 列卡片网格 |
| `src/store.ts` | Modify | exitFolder 追加 clearSelection + focusAsset(null) |
| `src/i18n/zh.ts` | Modify | 新增 sidebar.resetFilters |
| `src/i18n/en.ts` | Modify | 新增 sidebar.resetFilters |

---

## Task 1: i18n — 新增 resetFilters key

**Files:**
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 1: 在 `zh.ts` 的 `sidebar` 对象末尾追加**

找到 `sidebar` 对象的最后一个 key（`albumNamePlaceholder`），在其后追加：

```ts
    resetFilters: "重置筛选",
```

- [ ] **Step 2: 在 `en.ts` 的 `sidebar` 对象末尾追加**

同样找到 `sidebar` 对象末尾，追加：

```ts
    resetFilters: "Reset filters",
```

- [ ] **Step 3: TypeScript 编译验证**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -10
```

期望：无 error。

---

## Task 2: Sidebar — 移除刷新按钮，加重置筛选按钮

**Files:**
- Modify: `src/components/Sidebar.tsx`

当前文件结构（关键部分）：
- 第 3 行 import：`import { Search, RefreshCw, Sun, Moon, Eraser, Settings, Globe } from "lucide-react";`
- 第 24 行：`const refreshAssets = useStore((s) => s.refreshAssets);`
- 第 56-58 行：刷新按钮 `<Button onClick={() => refreshAssets()}>` + `<RefreshCw>`
- 第 60 行：分隔线 `<div className="h-4 w-px bg-zinc-800/60 mx-1" />`
- 第 77-126 行：筛选区 `<div className="flex items-center gap-2">` 包含三个 Select

- [ ] **Step 1: 将 lucide import 中的 `RefreshCw` 替换为 `RotateCcw`**

将：
```tsx
import { Search, RefreshCw, Sun, Moon, Eraser, Settings, Globe } from "lucide-react";
```
改为：
```tsx
import { Search, RotateCcw, Sun, Moon, Eraser, Settings, Globe } from "lucide-react";
```

- [ ] **Step 2: 移除刷新按钮和其后的分隔线**

删除以下两块（第 56-60 行）：
```tsx
      <Button onClick={() => refreshAssets()} variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" title={t("sidebar.refresh")}>
        <RefreshCw size={14} />
      </Button>

      <div className="h-4 w-px bg-zinc-800/60 mx-1" />
```

- [ ] **Step 3: 移除 `refreshAssets` 的 store 订阅**

删除：
```tsx
  const refreshAssets = useStore((s) => s.refreshAssets);
```

- [ ] **Step 4: 在筛选区三个 Select 之后追加重置按钮**

找到筛选区 `<div className="flex items-center gap-2">` 的闭合 `</div>`（在排序 Select 之后），在其**内部、排序 Select 之后**追加：

```tsx
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 flex-shrink-0"
          title={t("sidebar.resetFilters")}
          onClick={() => {
            setSearchText("");
            setQuery({
              camera_model: null,
              min_rating: null,
              sort_by: "date_taken",
              sort_dir: "desc",
              search: null,
            });
          }}
        >
          <RotateCcw size={14} />
        </Button>
```

- [ ] **Step 5: TypeScript 编译验证**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -10
```

期望：无 error。

---

## Task 3: store.exitFolder — 清空画布选中状态

**Files:**
- Modify: `src/store.ts`

当前 `exitFolder` 实现（约第 343-346 行）：
```ts
  exitFolder: async () => {
    set({ currentFolderId: null, currentFolderName: null });
    await get().setQuery({ album_id: null });
  },
```

- [ ] **Step 1: 在 `exitFolder` 中追加 clearSelection 和 focusAsset**

将 `exitFolder` 改为：

```ts
  exitFolder: async () => {
    set({ currentFolderId: null, currentFolderName: null });
    get().clearSelection();
    get().focusAsset(null);
    await get().setQuery({ album_id: null });
  },
```

- [ ] **Step 2: TypeScript 编译验证**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -10
```

期望：无 error。

---

## Task 4: FolderList — 卡片风格

**Files:**
- Modify: `src/components/FolderList.tsx`

将现有行列表（`<div className="flex-1 overflow-y-auto">` 内的 `filtered.map`）改为 2 列卡片网格。

- [ ] **Step 1: 将列表容器改为 grid 布局**

找到：
```tsx
      {/* 文件夹列表 */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="flex items-center justify-center h-full text-zinc-500 text-xs p-4 text-center">
            {t("folder.noFolders")}
          </div>
        )}
        {filtered.map((album) => (
          <div
            key={album.id}
            className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-800/40 cursor-pointer group"
            onClick={() => enterFolder(album.id, album.name)}
          >
            <Folder size={15} className="text-zinc-400 flex-shrink-0" />
            <span className="flex-1 text-sm truncate">{album.name}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 flex-shrink-0"
                >
                  <MoreHorizontal size={13} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openRename(album); }}>
                  {t("folder.rename")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={(e) => { e.stopPropagation(); openDelete(album); }}
                >
                  {t("folder.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>
```

替换为：

```tsx
      {/* 文件夹卡片网格 */}
      <div className="flex-1 overflow-y-auto p-2">
        {filtered.length === 0 && (
          <div className="flex items-center justify-center h-full text-zinc-500 text-xs p-4 text-center">
            {t("folder.noFolders")}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          {filtered.map((album) => (
            <div
              key={album.id}
              className="relative rounded-lg bg-zinc-900 hover:bg-zinc-800/80 cursor-pointer p-3 flex flex-col items-center gap-2 group"
              onClick={() => enterFolder(album.id, album.name)}
            >
              <Folder size={32} className="text-zinc-400 flex-shrink-0" />
              <span className="text-xs text-center truncate w-full">{album.name}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="absolute top-1.5 right-1.5 h-6 w-6 opacity-0 group-hover:opacity-100"
                  >
                    <MoreHorizontal size={13} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openRename(album); }}>
                    {t("folder.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={(e) => { e.stopPropagation(); openDelete(album); }}
                  >
                    {t("folder.delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      </div>
```

- [ ] **Step 2: TypeScript 编译验证**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -10
```

期望：无 error。

# 文件夹 UI 细节优化设计文档

**日期**：2026-05-18  
**状态**：待实现

---

## 1. 背景

文件夹导航功能实现后，需要三处 UI 细节调整：移除冗余的刷新按钮、补充重置筛选按钮、文件夹列表改为卡片风格、返回文件夹列表时清空画布选中状态。

---

## 2. 变更详情

### 2.1 Sidebar — 移除刷新按钮，加重置筛选按钮

**移除：**
- 左上角的 `<Button onClick={() => refreshAssets()}>` 刷新按钮（`RefreshCw` 图标）
- 刷新按钮后紧跟的分隔线 `<div className="h-4 w-px bg-zinc-800/60 mx-1" />`
- `refreshAssets` 的 store 订阅（如果不再被其他地方使用）

**新增：**
在筛选区三个 Select（相机/星级/排序）的右侧，追加一个重置按钮：

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

同时在 `zh.ts` / `en.ts` 的 `sidebar` 命名空间新增：
- `resetFilters: "重置筛选"` / `"Reset filters"`

**注意：** `RefreshCw` import 可移除，改为 `RotateCcw`。

---

### 2.2 FolderList — 卡片风格

将现有行列表改为 **2 列网格卡片**布局。

**布局结构：**

```
┌─────────────────────────────────┐
│ [搜索框]                  [+]   │  ← 顶部工具栏（不变）
├─────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐    │
│  │    📁    │  │    📁    │    │
│  │  文件夹A  │  │  文件夹B  │    │  ← 2列网格
│  └──────────┘  └──────────┘    │
│  ┌──────────┐                  │
│  │    📁    │                  │
│  │  文件夹C  │                  │
│  └──────────┘                  │
└─────────────────────────────────┘
```

**卡片样式：**
- 容器：`grid grid-cols-2 gap-2 p-2 overflow-y-auto`
- 每张卡片：`relative rounded-lg bg-zinc-900 hover:bg-zinc-800/80 cursor-pointer p-3 flex flex-col items-center gap-2`
- 文件夹图标：`Folder size={32} className="text-zinc-400"`
- 名称：`text-xs text-center truncate w-full`
- `⋯` 菜单按钮：`absolute top-1.5 right-1.5`，`opacity-0 group-hover:opacity-100`

**交互：**
- 点击卡片主体 → `enterFolder(album.id, album.name)`
- `⋯` 按钮 `e.stopPropagation()` 防止冒泡，触发重命名/删除菜单（逻辑不变）

---

### 2.3 store.exitFolder — 清空画布选中状态

在 `store.ts` 的 `exitFolder` action 中，额外清空选中和焦点状态：

```ts
exitFolder: async () => {
  set({ currentFolderId: null, currentFolderName: null });
  get().clearSelection();
  get().focusAsset(null);
  await get().setQuery({ album_id: null });
},
```

`clearSelection` 和 `focusAsset` 已是 store 内部 action，直接调用即可。

---

## 3. 文件变更清单

| 文件 | 变更类型 | 内容 |
|------|----------|------|
| `src/components/Sidebar.tsx` | Modify | 移除刷新按钮，加重置筛选按钮 |
| `src/components/FolderList.tsx` | Modify | 行列表改为 2 列卡片网格 |
| `src/store.ts` | Modify | `exitFolder` 追加 `clearSelection` + `focusAsset(null)` |
| `src/i18n/zh.ts` | Modify | 新增 `sidebar.resetFilters` |
| `src/i18n/en.ts` | Modify | 新增 `sidebar.resetFilters` |

---

## 4. 不在本次范围内

- 文件夹卡片封面图（显示文件夹内第一张素材缩略图）
- 卡片数量角标
- 拖拽排序

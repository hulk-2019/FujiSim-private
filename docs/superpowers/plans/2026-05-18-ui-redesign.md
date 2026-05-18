# UI 全面重设计实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 Modern Dark Cinema 风格对 FujiSim 的 Sidebar、FolderList、AssetGrid header 及所有弹框进行全面 UI 重设计，提升专业感和视觉层次。

**Architecture:** 纯前端样式改造，不涉及逻辑变更。设计系统：深色背景层级 `#0a0a0f / #111118 / #1a1a24`，强调色 `#6366F1`（indigo），边框 `rgba(255,255,255,0.07)`，动效 `cubic-bezier(0.16,1,0.3,1) 150-250ms`。所有组件保持现有逻辑，只替换 className。

**Tech Stack:** React 18 + TypeScript，Tailwind CSS，shadcn/ui，lucide-react

---

## 设计 Token（贯穿所有 Task）

```
背景：
  bg-[#0a0a0f]      最底层
  bg-[#111118]      面板/header
  bg-[#1a1a24]      悬浮/激活态
  bg-white/[0.03]   卡片默认
  bg-white/[0.06]   卡片 hover

文字：
  text-[#EDEDEF]    主文字
  text-[#8A8F98]    次要文字
  text-[#4A4F5A]    占位/禁用

强调：
  text-indigo-400   图标强调
  bg-indigo-600     主操作按钮
  bg-indigo-600/20  次要操作背景
  border-indigo-500/30  次要操作边框

边框：
  border-white/[0.07]   默认
  border-white/[0.12]   hover
  border-white/[0.09]   弹框

危险：
  bg-red-600/20 text-red-400 border-red-500/30
```

---

## File Map

| 文件 | 变更类型 | 职责 |
|------|----------|------|
| `src/components/Sidebar.tsx` | Modify | 顶部工具栏重设计 |
| `src/components/FolderList.tsx` | Modify | 文件夹列表 + 卡片 + 弹框重设计 |
| `src/components/AssetGrid.tsx` | Modify | folder header + 选择栏 + 弹框重设计 |

---

## Task 1: Sidebar 重设计

**Files:**
- Modify: `src/components/Sidebar.tsx`

整体目标：高度 44px，去掉分隔线，搜索框有 focus ring，Select 去边框只保留文字，重置按钮仅在有筛选时高亮。

- [ ] **Step 1: 替换 `<aside>` 根元素 className**

将：
```tsx
    <aside className="w-full px-4 py-2 bg-transparent flex items-center flex-wrap gap-3 text-sm relative z-10">
```
改为：
```tsx
    <aside className="w-full h-11 px-4 bg-[#111118] flex items-center gap-2 text-sm relative z-10 border-b border-white/[0.07]">
```

- [ ] **Step 2: 替换搜索框样式**

将搜索框区域：
```tsx
      <div className="relative w-40 flex-shrink-0">
        <Search size={14} className="absolute left-2.5 top-2 text-zinc-500" />
        <Input
          placeholder={t("sidebar.searchPlaceholder")}
          className="h-8 pl-8 text-xs"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setQuery({ search: searchText || null });
          }}
        />
      </div>
```
改为：
```tsx
      <div className="relative w-44 flex-shrink-0">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#4A4F5A] pointer-events-none" />
        <Input
          placeholder={t("sidebar.searchPlaceholder")}
          className="h-8 pl-8 text-xs bg-white/[0.05] border-white/[0.08] text-[#EDEDEF] placeholder:text-[#4A4F5A] rounded-lg focus-visible:border-indigo-500/60 focus-visible:ring-2 focus-visible:ring-indigo-500/20 focus-visible:ring-offset-0"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setQuery({ search: searchText || null });
          }}
        />
      </div>
```

- [ ] **Step 3: 删除搜索框后的分隔线**

删除：
```tsx
      <div className="h-4 w-px bg-zinc-800/60 mx-1" />
```

- [ ] **Step 4: 替换三个 Select 的 SelectTrigger className**

将三个 `<SelectTrigger>` 的 className 分别改为（相机、星级、排序各一个）：

相机 Select：
```tsx
          <SelectTrigger className="h-8 w-28 text-xs bg-transparent border-transparent text-[#8A8F98] hover:text-[#EDEDEF] hover:bg-white/[0.05] transition-colors rounded-lg [&>span]:truncate">
```

星级 Select：
```tsx
          <SelectTrigger className="h-8 w-24 text-xs bg-transparent border-transparent text-[#8A8F98] hover:text-[#EDEDEF] hover:bg-white/[0.05] transition-colors rounded-lg [&>span]:truncate">
```

排序 Select：
```tsx
          <SelectTrigger className="h-8 w-28 text-xs bg-transparent border-transparent text-[#8A8F98] hover:text-[#EDEDEF] hover:bg-white/[0.05] transition-colors rounded-lg [&>span]:truncate">
```

- [ ] **Step 5: 替换重置按钮样式，加条件高亮**

先在组件内计算是否有激活筛选（在 `const [searchText, setSearchText] = useState("")` 之后追加）：

```tsx
  const hasActiveFilters =
    !!query.camera_model ||
    !!query.min_rating ||
    !!searchText ||
    query.sort_by !== "date_taken" ||
    query.sort_dir !== "desc";
```

然后将重置按钮：
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
改为：
```tsx
        <Button
          size="icon"
          variant="ghost"
          className={cn(
            "h-8 w-8 flex-shrink-0 transition-all duration-200",
            hasActiveFilters
              ? "text-indigo-400 hover:text-indigo-300 hover:bg-indigo-500/10"
              : "text-[#4A4F5A] hover:text-[#8A8F98] opacity-50"
          )}
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
          <RotateCcw size={13} />
        </Button>
```

需要在文件顶部 import `cn`：
```tsx
import { cn } from "@/lib/utils";
```

- [ ] **Step 6: 替换右侧设置按钮样式**

将：
```tsx
            <Button size="icon" variant="ghost" className="h-8 w-8 flex-shrink-0" title={t("sidebar.settings")}>
              <Settings size={14} />
            </Button>
```
改为：
```tsx
            <Button size="icon" variant="ghost" className="h-8 w-8 flex-shrink-0 text-[#8A8F98] hover:text-[#EDEDEF] hover:bg-white/[0.05] transition-colors" title={t("sidebar.settings")}>
              <Settings size={14} />
            </Button>
```

- [ ] **Step 7: TypeScript 编译验证**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -10
```

期望：无 error。

---

## Task 2: FolderList 重设计

**Files:**
- Modify: `src/components/FolderList.tsx`

目标：顶部标题行 + 搜索行分离，卡片有边框+hover glow，弹框深色高质感。

- [ ] **Step 1: 替换根容器和顶部工具栏**

将：
```tsx
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 顶部工具栏 */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-zinc-800/60">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2 top-2 text-zinc-500" />
          <Input
            className="h-7 pl-7 text-xs"
            placeholder={t("folder.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 flex-shrink-0"
          title={t("folder.newFolder")}
          onClick={() => { setNewName(""); setNewNameError(""); setNewOpen(true); }}
        >
          <Plus size={14} />
        </Button>
      </div>
```
改为：
```tsx
  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0a0a0f]">
      {/* 标题行 */}
      <div className="h-11 px-4 flex items-center justify-between border-b border-white/[0.07] flex-shrink-0">
        <span className="text-xs font-semibold text-[#8A8F98] uppercase tracking-wider">{t("folder.title")}</span>
        <button
          className="h-7 w-7 flex items-center justify-center rounded-lg text-[#8A8F98] hover:text-[#EDEDEF] hover:bg-white/[0.06] transition-colors"
          title={t("folder.newFolder")}
          onClick={() => { setNewName(""); setNewNameError(""); setNewOpen(true); }}
        >
          <Plus size={15} />
        </button>
      </div>
      {/* 搜索行 */}
      <div className="px-3 py-2 border-b border-white/[0.07] flex-shrink-0">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#4A4F5A] pointer-events-none" />
          <Input
            className="h-8 pl-8 text-xs bg-white/[0.04] border-white/[0.07] text-[#EDEDEF] placeholder:text-[#4A4F5A] rounded-lg focus-visible:border-indigo-500/50 focus-visible:ring-1 focus-visible:ring-indigo-500/20 focus-visible:ring-offset-0"
            placeholder={t("folder.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
```

- [ ] **Step 2: 替换卡片网格区域**

将：
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
改为：
```tsx
      {/* 文件夹卡片网格 */}
      <div className="flex-1 overflow-y-auto p-3">
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-[#4A4F5A] text-xs p-4 text-center">
            <Folder size={32} className="text-[#1a1a24]" />
            <span>{t("folder.noFolders")}</span>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          {filtered.map((album) => (
            <div
              key={album.id}
              className="relative rounded-xl bg-white/[0.03] border border-white/[0.07] hover:bg-white/[0.06] hover:border-white/[0.12] hover:shadow-[0_0_0_1px_rgba(99,102,241,0.2)] cursor-pointer p-3 pt-4 flex flex-col items-center gap-2 group transition-all duration-150"
              onClick={() => enterFolder(album.id, album.name)}
            >
              <Folder size={28} className="text-indigo-400 flex-shrink-0" />
              <span className="text-[11px] font-medium text-[#EDEDEF] text-center truncate w-full leading-tight">{album.name}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                  <button
                    className="absolute top-1.5 right-1.5 h-6 w-6 flex items-center justify-center rounded-md bg-[#1a1a24] text-[#8A8F98] hover:text-[#EDEDEF] opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <MoreHorizontal size={12} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-[#16161f] border-white/[0.09]">
                  <DropdownMenuItem className="text-[#EDEDEF] hover:bg-white/[0.06] focus:bg-white/[0.06]" onClick={(e) => { e.stopPropagation(); openRename(album); }}>
                    {t("folder.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-red-400 hover:bg-red-500/10 focus:bg-red-500/10 focus:text-red-400"
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

- [ ] **Step 3: 替换新建弹框**

将：
```tsx
      {/* 新建弹框 */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogTitle>{t("folder.newFolder")}</DialogTitle>
          <Input
            className="mt-3"
            placeholder={t("folder.namePlaceholder")}
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setNewNameError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          />
          {newNameError && <p className="text-xs text-destructive mt-1">{newNameError}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={handleCreate} disabled={!newName.trim()}>{t("common.confirm")}</Button>
          </div>
        </DialogContent>
      </Dialog>
```
改为：
```tsx
      {/* 新建弹框 */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="bg-[#16161f] border-white/[0.09] rounded-2xl shadow-2xl shadow-black/60 gap-0 p-6">
          <DialogTitle className="text-base font-semibold text-[#EDEDEF] mb-4">{t("folder.newFolder")}</DialogTitle>
          <Input
            className="bg-white/[0.05] border-white/[0.1] text-[#EDEDEF] placeholder:text-[#4A4F5A] rounded-lg focus-visible:border-indigo-500/60 focus-visible:ring-2 focus-visible:ring-indigo-500/20 focus-visible:ring-offset-0"
            placeholder={t("folder.namePlaceholder")}
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setNewNameError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
            autoFocus
          />
          {newNameError && (
            <p className="text-xs text-red-400 mt-1.5 flex items-center gap-1">
              <span className="w-1 h-1 rounded-full bg-red-400 flex-shrink-0" />
              {newNameError}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" className="text-[#8A8F98] hover:text-[#EDEDEF] hover:bg-white/[0.06]" onClick={() => setNewOpen(false)}>{t("common.cancel")}</Button>
            <Button className="bg-indigo-600 hover:bg-indigo-500 text-white border-0" onClick={handleCreate} disabled={!newName.trim()}>{t("common.confirm")}</Button>
          </div>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 4: 替换重命名弹框**

将：
```tsx
      {/* 重命名弹框 */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogTitle>{t("folder.rename")}</DialogTitle>
          <Input
            className="mt-3"
            placeholder={t("folder.namePlaceholder")}
            value={renameName}
            onChange={(e) => { setRenameName(e.target.value); setRenameError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleRename(); }}
          />
          {renameError && <p className="text-xs text-destructive mt-1">{renameError}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={handleRename} disabled={!renameName.trim()}>{t("common.confirm")}</Button>
          </div>
        </DialogContent>
      </Dialog>
```
改为：
```tsx
      {/* 重命名弹框 */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="bg-[#16161f] border-white/[0.09] rounded-2xl shadow-2xl shadow-black/60 gap-0 p-6">
          <DialogTitle className="text-base font-semibold text-[#EDEDEF] mb-4">{t("folder.rename")}</DialogTitle>
          <Input
            className="bg-white/[0.05] border-white/[0.1] text-[#EDEDEF] placeholder:text-[#4A4F5A] rounded-lg focus-visible:border-indigo-500/60 focus-visible:ring-2 focus-visible:ring-indigo-500/20 focus-visible:ring-offset-0"
            placeholder={t("folder.namePlaceholder")}
            value={renameName}
            onChange={(e) => { setRenameName(e.target.value); setRenameError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleRename(); }}
            autoFocus
          />
          {renameError && (
            <p className="text-xs text-red-400 mt-1.5 flex items-center gap-1">
              <span className="w-1 h-1 rounded-full bg-red-400 flex-shrink-0" />
              {renameError}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" className="text-[#8A8F98] hover:text-[#EDEDEF] hover:bg-white/[0.06]" onClick={() => setRenameOpen(false)}>{t("common.cancel")}</Button>
            <Button className="bg-indigo-600 hover:bg-indigo-500 text-white border-0" onClick={handleRename} disabled={!renameName.trim()}>{t("common.confirm")}</Button>
          </div>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 5: 替换删除确认弹框**

将：
```tsx
      {/* 删除确认弹框 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) { setDeleteTarget(null); setDeleteCount(null); } }}>
        <DialogContent>
          <DialogTitle>{t("folder.delete")}</DialogTitle>
          <p className="text-sm text-zinc-400 mt-2">
            {deleteCount !== null && deleteCount > 0
              ? t("folder.confirmDelete", { count: deleteCount })
              : t("folder.confirmDeleteEmpty")}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setDeleteTarget(null); setDeleteCount(null); }}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={handleDelete}>{t("folder.delete")}</Button>
          </div>
        </DialogContent>
      </Dialog>
```
改为：
```tsx
      {/* 删除确认弹框 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) { setDeleteTarget(null); setDeleteCount(null); } }}>
        <DialogContent className="bg-[#16161f] border-white/[0.09] rounded-2xl shadow-2xl shadow-black/60 gap-0 p-6">
          <DialogTitle className="text-base font-semibold text-[#EDEDEF] mb-3">{t("folder.delete")}</DialogTitle>
          <p className="text-sm text-[#8A8F98] leading-relaxed">
            {deleteCount !== null && deleteCount > 0
              ? t("folder.confirmDelete", { count: deleteCount })
              : t("folder.confirmDeleteEmpty")}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" className="text-[#8A8F98] hover:text-[#EDEDEF] hover:bg-white/[0.06]" onClick={() => { setDeleteTarget(null); setDeleteCount(null); }}>{t("common.cancel")}</Button>
            <Button className="bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 hover:border-red-500/50" onClick={handleDelete}>{t("folder.delete")}</Button>
          </div>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 6: TypeScript 编译验证**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -10
```

期望：无 error。

---

## Task 3: AssetGrid 重设计

**Files:**
- Modify: `src/components/AssetGrid.tsx`

目标：folder header 更精致，选择栏更紧凑，批量操作按钮仅在有选中时显示，弹框深色高质感。

- [ ] **Step 1: 替换 loading 和 empty 状态**

将：
```tsx
  if (loading && totalCount === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        {t("assetGrid.loading")}
      </div>
    );
  }
  if (!loading && totalCount === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 text-sm gap-3 p-8">
        <ImageIcon size={48} className="text-zinc-700" />
        <div>{t("assetGrid.empty")}</div>
      </div>
    );
  }
```
改为：
```tsx
  if (loading && totalCount === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[#4A4F5A] text-xs">
        <div className="w-5 h-5 rounded-full border-2 border-indigo-500/30 border-t-indigo-400 animate-spin" />
        <span>{t("assetGrid.loading")}</span>
      </div>
    );
  }
  if (!loading && totalCount === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-[#4A4F5A] text-xs gap-3 p-8">
        <ImageIcon size={40} className="text-[#1a1a24]" />
        <div>{t("assetGrid.empty")}</div>
      </div>
    );
  }
```

- [ ] **Step 2: 替换 folder header**

将：
```tsx
      {/* 文件夹 header：返回箭头 + 文件夹名 + 导入按钮 */}
      <div className="border-b border-zinc-800/60 px-3 py-2 flex items-center gap-2">
        <button
          onClick={() => exitFolder()}
          className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
        >
          <ChevronLeft size={14} />
          <span className="truncate max-w-[160px]">{currentFolderName}</span>
        </button>
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button disabled={importing} size="sm" variant="default" className="h-7 text-xs pr-2">
                <FolderOpen size={13} className="mr-1" />
                {importing ? t("sidebar.importing") : t("sidebar.import")}
                <ChevronDown size={11} className="ml-1 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={pickAndImport}>
                <FolderOpen size={13} />
                {t("sidebar.importDir")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={pickFilesAndImport}>
                <Files size={13} />
                {t("sidebar.importFiles")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
```
改为：
```tsx
      {/* 文件夹 header：返回箭头 + 文件夹名 + 导入按钮 */}
      <div className="h-11 border-b border-white/[0.07] px-3 flex items-center gap-2 flex-shrink-0 bg-[#111118]">
        <button
          onClick={() => exitFolder()}
          className="flex items-center gap-1.5 text-xs text-[#8A8F98] hover:text-indigo-400 transition-colors group"
        >
          <ChevronLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
          <span className="font-medium text-[#EDEDEF] group-hover:text-indigo-300 truncate max-w-[160px] transition-colors">{currentFolderName}</span>
        </button>
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                disabled={importing}
                size="sm"
                className="h-7 text-xs bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 hover:border-indigo-500/50 rounded-lg pr-2 transition-all"
              >
                <FolderOpen size={12} className="mr-1.5" />
                {importing ? t("sidebar.importing") : t("sidebar.import")}
                <ChevronDown size={10} className="ml-1 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-[#16161f] border-white/[0.09]">
              <DropdownMenuItem className="text-[#EDEDEF] hover:bg-white/[0.06] focus:bg-white/[0.06]" onClick={pickAndImport}>
                <FolderOpen size={13} />
                {t("sidebar.importDir")}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-[#EDEDEF] hover:bg-white/[0.06] focus:bg-white/[0.06]" onClick={pickFilesAndImport}>
                <Files size={13} />
                {t("sidebar.importFiles")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
```

- [ ] **Step 3: 替换选择栏**

将：
```tsx
      <div className="border-b border-zinc-800/60 px-4 py-2 flex items-center gap-2 text-xs text-zinc-400 bg-zinc-950/40">
        <button
          onClick={() => (allSelected ? clearSelection() : selectAll())}
          className={cn(
            "flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-zinc-800/60",
            (allSelected || partiallySelected) && "text-primary",
          )}
          title={allSelected ? t("assetGrid.deselectAll") : t("assetGrid.selectAll")}
        >
          <span
            className={cn(
              "w-3.5 h-3.5 rounded-sm border flex items-center justify-center flex-shrink-0",
              allSelected
                ? "bg-primary border-primary"
                : partiallySelected
                  ? "bg-primary/40 border-primary"
                  : "border-zinc-600",
            )}
          >
            {allSelected && <Check size={10} className="text-primary-foreground" strokeWidth={3} />}
            {partiallySelected && <span className="w-1.5 h-0.5 bg-white rounded" />}
          </span>
          {allSelected
            ? t("assetGrid.deselectAll")
            : partiallySelected
              ? t("assetGrid.selected", { count: selectedIds.size })
              : t("assetGrid.selectAllShort")}
        </button>
        <span className="text-zinc-500 ml-1">
          {selectedIds.size > 0
            ? `${t("assetGrid.selected", { count: selectedIds.size })} / ${t("assetGrid.total", { count: totalCount })}`
            : t("assetGrid.total", { count: totalCount })}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <Button size="icon" variant="outline" className="h-7 w-7 flex-shrink-0" disabled={ids.length === 0} onClick={() => setMoveOpen(true)} title={t("assetGrid.addToAlbum")}>
            <FolderPlus size={14} />
          </Button>
          <Button size="icon" variant="destructive" className="h-7 w-7 flex-shrink-0" disabled={ids.length === 0} onClick={() => setDeleteOpen(true)} title={t("assetGrid.delete")}>
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
```
改为：
```tsx
      <div className="border-b border-white/[0.07] px-3 h-10 flex items-center gap-2 text-xs flex-shrink-0 bg-[#111118]">
        <button
          onClick={() => (allSelected ? clearSelection() : selectAll())}
          className={cn(
            "flex items-center gap-1.5 px-1.5 py-0.5 rounded-md hover:bg-white/[0.05] transition-colors",
            (allSelected || partiallySelected) ? "text-indigo-400" : "text-[#8A8F98]",
          )}
          title={allSelected ? t("assetGrid.deselectAll") : t("assetGrid.selectAll")}
        >
          <span
            className={cn(
              "w-3.5 h-3.5 rounded-sm border flex items-center justify-center flex-shrink-0 transition-colors",
              allSelected
                ? "bg-indigo-600 border-indigo-600"
                : partiallySelected
                  ? "bg-indigo-600/40 border-indigo-500"
                  : "border-white/[0.2]",
            )}
          >
            {allSelected && <Check size={10} className="text-white" strokeWidth={3} />}
            {partiallySelected && <span className="w-1.5 h-0.5 bg-indigo-300 rounded" />}
          </span>
          {allSelected
            ? t("assetGrid.deselectAll")
            : partiallySelected
              ? t("assetGrid.selected", { count: selectedIds.size })
              : t("assetGrid.selectAllShort")}
        </button>
        <span className="text-[#4A4F5A]">
          {selectedIds.size > 0
            ? `${selectedIds.size} / ${totalCount}`
            : totalCount}
        </span>

        <div className={cn("ml-auto flex items-center gap-1.5 transition-opacity duration-150", ids.length === 0 ? "opacity-0 pointer-events-none" : "opacity-100")}>
          <Button size="icon" variant="ghost" className="h-7 w-7 flex-shrink-0 text-[#8A8F98] hover:text-[#EDEDEF] hover:bg-white/[0.06]" onClick={() => setMoveOpen(true)} title={t("assetGrid.addToAlbum")}>
            <FolderPlus size={14} />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 flex-shrink-0 text-red-400/70 hover:text-red-400 hover:bg-red-500/10" onClick={() => setDeleteOpen(true)} title={t("assetGrid.delete")}>
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
```

- [ ] **Step 4: 替换移动到文件夹弹框**

将：
```tsx
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogTitle>{t("assetGrid.addToAlbum")}</DialogTitle>
          <DialogDescription>
            {t("assetGrid.addToAlbumDesc", { count: ids.length })}
          </DialogDescription>
          <div className="mt-3">
            {albums.length === 0 ? (
              <p className="text-xs text-zinc-500">
                {t("assetGrid.noAlbums")}
              </p>
            ) : (
              <Select value={moveTargetAlbum} onValueChange={setMoveTargetAlbum}>
                <SelectTrigger>
                  <SelectValue placeholder={t("assetGrid.albumPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {albums.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMoveOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={doMove} disabled={!moveTargetAlbum || albums.length === 0}>
              {t("assetGrid.add")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
```
改为：
```tsx
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="bg-[#16161f] border-white/[0.09] rounded-2xl shadow-2xl shadow-black/60 gap-0 p-6">
          <DialogTitle className="text-base font-semibold text-[#EDEDEF] mb-1">{t("assetGrid.addToAlbum")}</DialogTitle>
          <DialogDescription className="text-xs text-[#8A8F98] mb-4">
            {t("assetGrid.addToAlbumDesc", { count: ids.length })}
          </DialogDescription>
          <div>
            {albums.length === 0 ? (
              <p className="text-xs text-[#4A4F5A]">
                {t("assetGrid.noAlbums")}
              </p>
            ) : (
              <Select value={moveTargetAlbum} onValueChange={setMoveTargetAlbum}>
                <SelectTrigger className="bg-white/[0.05] border-white/[0.1] text-[#EDEDEF] rounded-lg focus:border-indigo-500/60 focus:ring-indigo-500/20">
                  <SelectValue placeholder={t("assetGrid.albumPlaceholder")} />
                </SelectTrigger>
                <SelectContent className="bg-[#16161f] border-white/[0.09]">
                  {albums.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)} className="text-[#EDEDEF] focus:bg-white/[0.06]">{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" className="text-[#8A8F98] hover:text-[#EDEDEF] hover:bg-white/[0.06]" onClick={() => setMoveOpen(false)}>{t("common.cancel")}</Button>
            <Button className="bg-indigo-600 hover:bg-indigo-500 text-white border-0" onClick={doMove} disabled={!moveTargetAlbum || albums.length === 0}>
              {t("assetGrid.add")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 5: 替换删除弹框**

将：
```tsx
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogTitle>{t("assetGrid.deleteTitle", { count: ids.length })}</DialogTitle>
          <DialogDescription>
            {t("assetGrid.deleteDesc")}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="secondary" onClick={() => doDelete(false)}>{t("assetGrid.removeRecord")}</Button>
            <Button variant="destructive" onClick={() => doDelete(true)}>
              {t("assetGrid.moveToTrash")}
```
改为：
```tsx
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="bg-[#16161f] border-white/[0.09] rounded-2xl shadow-2xl shadow-black/60 gap-0 p-6">
          <DialogTitle className="text-base font-semibold text-[#EDEDEF] mb-1">{t("assetGrid.deleteTitle", { count: ids.length })}</DialogTitle>
          <DialogDescription className="text-sm text-[#8A8F98] leading-relaxed mb-5">
            {t("assetGrid.deleteDesc")}
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="text-[#8A8F98] hover:text-[#EDEDEF] hover:bg-white/[0.06]" onClick={() => setDeleteOpen(false)}>{t("common.cancel")}</Button>
            <Button className="bg-white/[0.06] hover:bg-white/[0.1] text-[#EDEDEF] border border-white/[0.1]" onClick={() => doDelete(false)}>{t("assetGrid.removeRecord")}</Button>
            <Button className="bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 hover:border-red-500/50" onClick={() => doDelete(true)}>
              {t("assetGrid.moveToTrash")}
```

- [ ] **Step 6: TypeScript 编译验证**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -10
```

期望：无 error。

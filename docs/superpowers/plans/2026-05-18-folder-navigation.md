# 文件夹导航功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有相册（Album）升级为文件夹导航体验：左侧面板展示文件夹列表，进入文件夹后才能导入文件，所有查询自动叠加文件夹过滤条件。

**Architecture:** 后端复用 `albums` 表，新增 `name_exists`、`rename`、`asset_count`、`delete_with_assets` 四个 DB 函数及对应 IPC 命令；前端 store 新增 `currentFolderId/Name`、`enterFolder`、`exitFolder`；左列根据 `currentFolderId` 条件渲染 `FolderList`（文件夹列表）或 `AssetGrid`（资产网格）；导入按钮从 Sidebar 移至 AssetGrid header。

**Tech Stack:** Rust/sqlx（后端），React 18 + TypeScript，zustand，lucide-react，shadcn/ui

---

## File Map

| 文件 | 变更类型 | 职责 |
|------|----------|------|
| `src-tauri/src/db/albums.rs` | Modify | 新增 `name_exists`、`rename`、`asset_count`、`delete_with_assets` |
| `src-tauri/src/ipc.rs` | Modify | 新增 4 个 IPC 命令 |
| `src-tauri/src/lib.rs` | Modify | 注册新命令到 `invoke_handler` |
| `src/api.ts` | Modify | 新增 `checkAlbumNameExists`、`renameAlbum`、`getFolderAssetCount`、`deleteFolder` |
| `src/store.ts` | Modify | 新增 `currentFolderId`、`currentFolderName`、`enterFolder`、`exitFolder` |
| `src/App.tsx` | Modify | 左列条件渲染 `FolderList` 或 `AssetGrid` |
| `src/components/FolderList.tsx` | Create | 文件夹列表组件（增删改查 + 搜索） |
| `src/components/AssetGrid.tsx` | Modify | 顶部 header 加返回箭头 + 导入按钮 |
| `src/components/Sidebar.tsx` | Modify | 移除导入按钮和相册 Select |
| `src/i18n/zh.ts` | Modify | 新增 folder 命名空间 key |
| `src/i18n/en.ts` | Modify | 新增 folder 命名空间 key |

---

## Task 1: 后端 DB — 新增 albums.rs 函数

**Files:**
- Modify: `src-tauri/src/db/albums.rs`

- [ ] **Step 1: 在 `albums.rs` 末尾追加四个函数**

```rust
/// 检查名称是否已存在。`exclude_id` 用于重命名时排除自身。
pub async fn name_exists(
    pool: &SqlitePool,
    name: &str,
    exclude_id: Option<i64>,
) -> Result<bool> {
    let count: (i64,) = match exclude_id {
        Some(eid) => sqlx::query_as(
            "SELECT COUNT(*) FROM albums WHERE name = ? AND id != ?",
        )
        .bind(name)
        .bind(eid)
        .fetch_one(pool)
        .await?,
        None => sqlx::query_as("SELECT COUNT(*) FROM albums WHERE name = ?")
            .bind(name)
            .fetch_one(pool)
            .await?,
    };
    Ok(count.0 > 0)
}
```

- [ ] **Step 2: 追加 `rename` 函数**

```rust
pub async fn rename(pool: &SqlitePool, id: i64, name: &str) -> Result<Album> {
    sqlx::query("UPDATE albums SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query_as::<_, Album>("SELECT * FROM albums WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}
```

- [ ] **Step 3: 追加 `asset_count` 和 `delete_with_assets` 函数**

```rust
/// 查询文件夹内资产数量（用于删除确认弹框）。
pub async fn asset_count(pool: &SqlitePool, id: i64) -> Result<i64> {
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM album_assets WHERE album_id = ?")
            .bind(id)
            .fetch_one(pool)
            .await?;
    Ok(count)
}

/// 事务内物理删除文件夹：删除所有关联资产文件 → 删除资产记录 → 删除文件夹行。
/// 任一步失败则回滚。
pub async fn delete_with_assets(
    pool: &SqlitePool,
    id: i64,
) -> Result<Vec<String>> {
    // 返回被删除的文件路径列表，供调用方物理删除文件
    let paths: Vec<(String,)> = sqlx::query_as(
        "SELECT a.file_path FROM assets a \
         INNER JOIN album_assets aa ON aa.asset_id = a.id \
         WHERE aa.album_id = ?",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;

    let mut tx = pool.begin().await?;
    // 删除资产记录（album_assets 行因 ON DELETE CASCADE 自动清理）
    sqlx::query(
        "DELETE FROM assets WHERE id IN \
         (SELECT asset_id FROM album_assets WHERE album_id = ?)",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    // 删除文件夹行
    sqlx::query("DELETE FROM albums WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(paths.into_iter().map(|(p,)| p).collect())
}
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

期望：无 error。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/albums.rs
git commit -m "feat(db): add name_exists, rename, asset_count, delete_with_assets to albums"
```

---

## Task 2: 后端 IPC — 新增四个命令

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 `ipc.rs` 的 `delete_album` 函数之后追加四个命令**

```rust
#[tauri::command]
pub async fn check_album_name_exists(
    state: State<'_, SharedState>,
    name: String,
    exclude_id: Option<i64>,
) -> Result<bool> {
    albums::name_exists(&state.pool, &name, exclude_id).await
}

#[tauri::command]
pub async fn rename_album(
    state: State<'_, SharedState>,
    id: i64,
    name: String,
) -> Result<albums::Album> {
    albums::rename(&state.pool, id, &name).await
}

#[tauri::command]
pub async fn get_folder_asset_count(
    state: State<'_, SharedState>,
    id: i64,
) -> Result<i64> {
    albums::asset_count(&state.pool, id).await
}

#[tauri::command]
pub async fn delete_folder(
    state: State<'_, SharedState>,
    id: i64,
) -> Result<()> {
    let paths = albums::delete_with_assets(&state.pool, id).await?;
    for p in paths {
        let path = std::path::PathBuf::from(&p);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}
```

- [ ] **Step 2: 在 `lib.rs` 的 `invoke_handler` 中注册新命令**

找到 `ipc::delete_album,` 这一行，在其后追加：

```rust
            ipc::check_album_name_exists,
            ipc::rename_album,
            ipc::get_folder_asset_count,
            ipc::delete_folder,
```

- [ ] **Step 3: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

期望：无 error。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): add check_album_name_exists, rename_album, get_folder_asset_count, delete_folder commands"
```

---

## Task 3: 前端 API + Store

**Files:**
- Modify: `src/api.ts`
- Modify: `src/store.ts`

- [ ] **Step 1: 在 `api.ts` 的 `deleteAlbum` 之后追加四个方法**

```ts
  checkAlbumNameExists: (name: string, excludeId?: number | null) =>
    invoke<boolean>("check_album_name_exists", {
      name,
      excludeId: excludeId ?? null,
    }),
  renameAlbum: (id: number, name: string) =>
    invoke<Album>("rename_album", { id, name }),
  getFolderAssetCount: (id: number) =>
    invoke<number>("get_folder_asset_count", { id }),
  deleteFolder: (id: number) => invoke<void>("delete_folder", { id }),
```

- [ ] **Step 2: 在 `store.ts` 的 `AppState` 类型中新增字段和 actions**

在 `albums: Album[];` 之后追加：

```ts
  currentFolderId: number | null;
  currentFolderName: string | null;
  enterFolder: (id: number, name: string) => Promise<void>;
  exitFolder: () => Promise<void>;
```

- [ ] **Step 3: 在 `useStore` 初始值中新增字段**

在 `albums: [],` 之后追加：

```ts
  currentFolderId: null,
  currentFolderName: null,
```

- [ ] **Step 4: 在 `refreshAlbums` 之后追加两个 action 实现**

```ts
  enterFolder: async (id, name) => {
    set({ currentFolderId: id, currentFolderName: name });
    await get().setQuery({ album_id: id });
  },

  exitFolder: async () => {
    set({ currentFolderId: null, currentFolderName: null });
    await get().setQuery({ album_id: null });
  },
```

- [ ] **Step 5: TypeScript 编译验证**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -20
```

期望：无 error。

- [ ] **Step 6: Commit**

```bash
git add src/api.ts src/store.ts
git commit -m "feat(store): add currentFolderId, enterFolder, exitFolder; add folder API methods"
```

---

## Task 4: i18n 文案

**Files:**
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 1: 在 `zh.ts` 中新增 `folder` 命名空间**

在文件末尾（`export default` 对象内最后一个 key 之后）追加：

```ts
  folder: {
    title: "文件夹",
    searchPlaceholder: "搜索文件夹",
    newFolder: "新建文件夹",
    rename: "重命名",
    delete: "删除",
    namePlaceholder: "文件夹名称",
    nameExists: "文件夹名称已存在",
    confirmDelete: "将同时物理删除文件夹内 {{count}} 个文件，此操作不可恢复。",
    confirmDeleteEmpty: "确认删除此空文件夹？",
    noFolders: "还没有文件夹，点击右上角 + 新建",
  },
```

- [ ] **Step 2: 在 `en.ts` 中新增 `folder` 命名空间**

```ts
  folder: {
    title: "Folders",
    searchPlaceholder: "Search folders",
    newFolder: "New folder",
    rename: "Rename",
    delete: "Delete",
    namePlaceholder: "Folder name",
    nameExists: "Folder name already exists",
    confirmDelete: "This will permanently delete {{count}} file(s) inside. This cannot be undone.",
    confirmDeleteEmpty: "Delete this empty folder?",
    noFolders: "No folders yet. Click + to create one.",
  },
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(i18n): add folder namespace keys"
```

---

## Task 5: 新建 FolderList 组件

**Files:**
- Create: `src/components/FolderList.tsx`

- [ ] **Step 1: 创建文件，写入完整组件（第一部分：imports + 类型 + 新建弹框逻辑）**

```tsx
import { useState, useMemo } from "react";
import { Plus, Search, MoreHorizontal, Folder } from "lucide-react";
import { useStore } from "@/store";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "react-i18next";
import type { Album } from "@/types";

export function FolderList() {
  const { t } = useTranslation();
  const albums = useStore((s) => s.albums);
  const refreshAlbums = useStore((s) => s.refreshAlbums);
  const enterFolder = useStore((s) => s.enterFolder);

  const [search, setSearch] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newNameError, setNewNameError] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Album | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Album | null>(null);
  const [deleteCount, setDeleteCount] = useState<number | null>(null);

  const filtered = useMemo(
    () =>
      albums.filter((a) =>
        a.name.toLowerCase().includes(search.toLowerCase()),
      ),
    [albums, search],
  );

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const exists = await api.checkAlbumNameExists(name);
    if (exists) {
      setNewNameError(t("folder.nameExists"));
      return;
    }
    await api.createAlbum(name);
    setNewName("");
    setNewOpen(false);
    setNewNameError("");
    await refreshAlbums();
  }

  async function openRename(album: Album) {
    setRenameTarget(album);
    setRenameName(album.name);
    setRenameError("");
    setRenameOpen(true);
  }

  async function handleRename() {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name) return;
    const exists = await api.checkAlbumNameExists(name, renameTarget.id);
    if (exists) {
      setRenameError(t("folder.nameExists"));
      return;
    }
    await api.renameAlbum(renameTarget.id, name);
    setRenameOpen(false);
    setRenameTarget(null);
    await refreshAlbums();
  }

  async function openDelete(album: Album) {
    const count = await api.getFolderAssetCount(album.id);
    setDeleteTarget(album);
    setDeleteCount(count);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    await api.deleteFolder(deleteTarget.id);
    setDeleteTarget(null);
    setDeleteCount(null);
    await refreshAlbums();
  }
```

- [ ] **Step 2: 追加 JSX 返回部分**

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

      {/* 删除确认弹框 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) { setDeleteTarget(null); setDeleteCount(null); } }}>
        <DialogContent>
          <DialogTitle>{t("folder.delete")}</DialogTitle>
          <p className="text-sm text-zinc-400 mt-2">
            {deleteCount && deleteCount > 0
              ? t("folder.confirmDelete", { count: deleteCount })
              : t("folder.confirmDeleteEmpty")}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setDeleteTarget(null); setDeleteCount(null); }}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={handleDelete}>{t("folder.delete")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 3: TypeScript 编译验证**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -20
```

期望：无 error。

- [ ] **Step 4: Commit**

```bash
git add src/components/FolderList.tsx
git commit -m "feat: add FolderList component with create/rename/delete/search"
```

---

## Task 6: App.tsx — 左列条件渲染

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: 导入 FolderList 和 useStore**

在 `App.tsx` 顶部 import 区追加：

```tsx
import { FolderList } from "@/components/FolderList";
```

- [ ] **Step 2: 在 `App()` 函数内读取 `currentFolderId`**

在 `const markThumbnailReady` 之后追加：

```tsx
  const currentFolderId = useStore((s) => s.currentFolderId);
```

- [ ] **Step 3: 替换左列内容**

将：

```tsx
        <div className="w-[360px] flex-shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800/60 overflow-hidden">
          <AssetGrid />
        </div>
```

改为：

```tsx
        <div className="w-[360px] flex-shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800/60 overflow-hidden">
          {currentFolderId === null ? <FolderList /> : <AssetGrid />}
        </div>
```

- [ ] **Step 4: 在 `useEffect` 初始化中补充 `refreshAlbums`**

将：

```tsx
    const { refreshAssets, refreshFacets, refreshPresets, refreshUserLuts, setThumbnailDir, setCoverDir } = useStore.getState();
    refreshAssets();
    refreshFacets();
    refreshPresets();
    refreshUserLuts();
```

改为：

```tsx
    const { refreshAssets, refreshFacets, refreshPresets, refreshUserLuts, refreshAlbums, setThumbnailDir, setCoverDir } = useStore.getState();
    refreshAssets();
    refreshFacets();
    refreshPresets();
    refreshUserLuts();
    refreshAlbums();
```

- [ ] **Step 5: TypeScript 编译验证**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat: conditionally render FolderList or AssetGrid in left panel"
```

---

## Task 7: AssetGrid — 顶部 header 加返回箭头 + 导入按钮

**Files:**
- Modify: `src/components/AssetGrid.tsx`

- [ ] **Step 1: 在 `AssetGrid.tsx` 顶部追加必要 imports**

在现有 import 区追加（`ChevronLeft`、`FolderOpen`、`Files`、`ChevronDown` 来自 lucide-react，`open as openDialog` 来自 tauri dialog）：

```tsx
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronLeft, FolderOpen, Files, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
```

注意：`Check`、`FileImage`、`ImageIcon`、`Pencil`、`FolderPlus`、`Trash2` 已存在，不要重复导入。

- [ ] **Step 2: 在 `AssetGrid` 函数内读取新 store 字段**

在现有 `const query` 之后追加：

```tsx
  const currentFolderName = useStore((s) => s.currentFolderName);
  const exitFolder = useStore((s) => s.exitFolder);
  const importing = useStore((s) => s.importing);
  const setImporting = useStore((s) => s.setImporting);
  const refreshFacets = useStore((s) => s.refreshFacets);
```

- [ ] **Step 3: 在 `AssetGrid` 函数内追加导入函数**

在 `doDelete` 函数之后追加：

```tsx
  async function pickAndImport() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") return;
    setImporting(true);
    try {
      const report = await api.importDirectory(selected, query.album_id ?? null);
      setImporting(false, { inserted: report.inserted, scanned: report.scanned });
      await Promise.all([refreshAssets(), refreshFacets()]);
    } catch {
      setImporting(false);
    }
  }

  async function pickFilesAndImport() {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "Images", extensions: ["jpg","jpeg","png","tif","tiff","webp","heic","heif","arw","cr2","cr3","nef","nrw","raf","rw2","dng","orf","pef","srw","rwl","sr2"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    setImporting(true);
    try {
      const report = await api.importFiles(paths, query.album_id ?? null);
      setImporting(false, { inserted: report.inserted, scanned: report.scanned });
      await Promise.all([refreshAssets(), refreshFacets()]);
    } catch {
      setImporting(false);
    }
  }
```

- [ ] **Step 4: 在 `return` 的最外层 `<div>` 内、`<div className="border-b ...">` 之前插入 folder header**

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

- [ ] **Step 5: TypeScript 编译验证**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add src/components/AssetGrid.tsx
git commit -m "feat(AssetGrid): add folder header with back button and import dropdown"
```

---

## Task 8: Sidebar — 移除导入按钮和相册 Select

**Files:**
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: 移除 Sidebar 中的导入相关 state 和函数**

删除以下内容：
- `const importing = useStore(...)` 行
- `const setImporting = useStore(...)` 行
- `const albums = useStore(...)` 行
- `const refreshAlbums = useStore(...)` 行
- `const [newAlbumOpen, setNewAlbumOpen] = useState(false)` 行
- `const [newAlbum, setNewAlbum] = useState("")` 行
- `useEffect(() => { useStore.getState().refreshAlbums(); }, [])` 整块
- `pickAndImport` 函数整块
- `pickFilesAndImport` 函数整块
- `createAlbum` 函数整块

- [ ] **Step 2: 移除 JSX 中的导入按钮 DropdownMenu 和相册 Select**

删除 JSX 中：
- 导入按钮 `<DropdownMenu>...</DropdownMenu>` 整块（含 `<Button disabled={importing}>` 的那个）
- 刷新按钮旁边的分隔线 `<div className="h-4 w-px ...">` 如果只为导入区服务
- 相册 `<Select value={query.album_id ...}>` 整块
- 新建相册 `<Dialog open={newAlbumOpen}>` 整块

保留：搜索框、相机筛选、星级筛选、排序、导出任务 Popover、设置菜单、刷新按钮。

- [ ] **Step 3: 清理不再使用的 imports**

移除 `FolderOpen`、`Plus`、`Files`、`ChevronDown` 如果 Sidebar 不再使用它们（检查 JSX 确认）。

- [ ] **Step 4: TypeScript 编译验证**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(Sidebar): remove import button and album select, moved to AssetGrid"
```

---

## Task 9: 端到端验证

- [ ] **Step 1: 启动开发服务器**

```bash
cd /Users/ry2019/private/FujiSim && npm run tauri dev
```

- [ ] **Step 2: 验证文件夹列表视图**

- 首次启动左列显示文件夹列表（空状态显示提示文字）
- 点击 `+` 新建文件夹，输入名称后确认，列表刷新
- 重复名称时显示"文件夹名称已存在"错误
- 搜索框可过滤文件夹

- [ ] **Step 3: 验证进入/退出文件夹**

- 点击文件夹行，左列切换为 AssetGrid，顶部显示返回箭头 + 文件夹名
- 点击返回箭头，左列切回 FolderList
- 进入文件夹后，资产列表只显示该文件夹内的资产

- [ ] **Step 4: 验证导入约束**

- 在 FolderList 视图（未进入文件夹）时，Sidebar 无导入按钮
- 进入文件夹后，AssetGrid header 显示导入按钮
- 导入后资产出现在当前文件夹内

- [ ] **Step 5: 验证重命名和删除**

- 悬停文件夹行，`⋯` 菜单出现
- 重命名：预填当前名称，重名校验正常
- 删除有资产的文件夹：弹框显示资产数量，确认后文件夹和文件均被删除
- 删除空文件夹：弹框显示空文件夹提示

- [ ] **Step 6: 最终 Commit**

```bash
git add -A
git commit -m "feat: folder navigation — complete implementation"
```


# 文件夹独立页面 + 回收站 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将文件夹功能改为独立全屏页面（React Router），并新增回收站（软删除 + 恢复 + 永久删除）。

**Architecture:** 引入 `react-router-dom` BrowserRouter，新增 `/projects`、`/projects/:folderId`、`/trash` 三条路由；后端 `albums` 表加 `is_deleted`/`deleted_at` 软删除字段；前端新增 `NavSidebar`、`ProjectsPage`、`EditorPage`、`TrashPage` 四个组件。

**Tech Stack:** React 18, TypeScript, react-router-dom v6, Zustand, Tailwind CSS, Tauri 2 IPC, SQLite (sqlx), Rust

---

## 文件清单

### 新建
- `src/pages/ProjectsPage.tsx` — 文件夹网格页
- `src/pages/EditorPage.tsx` — 素材编辑三栏页
- `src/pages/TrashPage.tsx` — 回收站页
- `src/components/NavSidebar.tsx` — 左侧导航栏

### 修改
- `src-tauri/src/db/mod.rs` — 增量迁移加两列
- `src-tauri/src/db/albums.rs` — Album 结构体 + 软删除逻辑 + 新增函数
- `src-tauri/src/ipc.rs` — 新增 4 个 IPC 命令 + `get_album_summaries`
- `src-tauri/src/lib.rs` — 注册新命令
- `src/types.ts` — Album 类型新增字段
- `src/api.ts` — 新增 5 个 API 调用
- `src/store.ts` — 新增 trash 状态与 actions
- `src/App.tsx` — 改为 BrowserRouter 路由布局
- `src/i18n/zh.ts` — 新增 trash/nav 翻译键
- `src/i18n/en.ts` — 新增 trash/nav 翻译键

---

## Task 1: 后端数据库迁移 — albums 软删除字段

**Files:**
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/db/albums.rs`

- [ ] **Step 1: 在 `db/mod.rs` 增量迁移列表追加两条 ALTER TABLE**

在 `run_migrations` 函数的 `for sql in [` 列表末尾（`"ALTER TABLE assets ADD COLUMN cover_path TEXT",` 之后）追加：

```rust
"ALTER TABLE albums ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0",
"ALTER TABLE albums ADD COLUMN deleted_at TEXT",
```

- [ ] **Step 2: 更新 `db/albums.rs` 的 `Album` 结构体**

将现有结构体替换为：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Album {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub is_deleted: i64,
    pub deleted_at: Option<String>,
}
```

- [ ] **Step 3: 修改 `list()` 过滤已删除记录**

```rust
pub async fn list(pool: &SqlitePool) -> Result<Vec<Album>> {
    sqlx::query_as::<_, Album>("SELECT * FROM albums WHERE is_deleted = 0 ORDER BY name")
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}
```

- [ ] **Step 4: 将 `delete()` 和 `delete_with_assets()` 改为软删除**

```rust
pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query(
        "UPDATE albums SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_with_assets(pool: &SqlitePool, id: i64) -> Result<Vec<String>> {
    sqlx::query(
        "UPDATE albums SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(vec![])
}
```

- [ ] **Step 5: 新增 `list_trash()`、`restore()`、`purge()`、`purge_all()`**

在文件末尾追加：

```rust
pub async fn list_trash(pool: &SqlitePool) -> Result<Vec<Album>> {
    sqlx::query_as::<_, Album>(
        "SELECT * FROM albums WHERE is_deleted = 1 ORDER BY deleted_at DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn restore(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query(
        "UPDATE albums SET is_deleted = 0, deleted_at = NULL WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn purge(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM albums WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn purge_all(pool: &SqlitePool) -> Result<()> {
    sqlx::query("DELETE FROM albums WHERE is_deleted = 1")
        .execute(pool)
        .await?;
    Ok(())
}
```

- [ ] **Step 6: 构建验证**

```bash
cargo build 2>&1 | grep -E "error|warning: unused"
```

Expected: 无 error，允许有 warning。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/db/albums.rs
git commit -m "feat(db): soft-delete albums with is_deleted/deleted_at fields"
```

---

## Task 2: 后端 IPC — 新增相册摘要 + 回收站命令

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 `ipc.rs` 新增 `AlbumSummary` 结构体和 `get_album_summaries` 命令**

在文件顶部 `use` 区域后、第一个 `pub async fn` 之前，追加结构体定义：

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct AlbumSummary {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub is_deleted: i64,
    pub deleted_at: Option<String>,
    pub total: i64,
    pub cover_paths: Vec<String>,
}
```

然后在文件末尾追加命令：

```rust
#[tauri::command]
pub async fn get_album_summaries(
    state: State<'_, SharedState>,
) -> Result<Vec<AlbumSummary>> {
    let albums = albums::list(&state.pool).await?;
    let mut summaries = Vec::with_capacity(albums.len());
    for album in albums {
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM album_assets WHERE album_id = ?",
        )
        .bind(album.id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);

        let covers: Vec<String> = sqlx::query_scalar(
            "SELECT COALESCE(a.cover_path, a.file_path) \
             FROM album_assets aa \
             JOIN assets a ON a.id = aa.asset_id \
             WHERE aa.album_id = ? \
             ORDER BY a.date_taken DESC \
             LIMIT 4",
        )
        .bind(album.id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

        summaries.push(AlbumSummary {
            id: album.id,
            name: album.name,
            created_at: album.created_at,
            is_deleted: album.is_deleted,
            deleted_at: album.deleted_at,
            total,
            cover_paths: covers,
        });
    }
    Ok(summaries)
}
```

- [ ] **Step 2: 在 `ipc.rs` 末尾追加回收站命令**

```rust
#[tauri::command]
pub async fn list_trash_albums(
    state: State<'_, SharedState>,
) -> Result<Vec<albums::Album>> {
    albums::list_trash(&state.pool).await
}

#[tauri::command]
pub async fn restore_album(state: State<'_, SharedState>, id: i64) -> Result<()> {
    albums::restore(&state.pool, id).await
}

#[tauri::command]
pub async fn purge_album(state: State<'_, SharedState>, id: i64) -> Result<()> {
    albums::purge(&state.pool, id).await
}

#[tauri::command]
pub async fn purge_all_trash(state: State<'_, SharedState>) -> Result<()> {
    albums::purge_all(&state.pool).await
}
```

- [ ] **Step 3: 在 `lib.rs` 的 `generate_handler!` 列表中注册新命令**

在现有 `ipc::list_albums,` 附近追加：

```rust
ipc::get_album_summaries,
ipc::list_trash_albums,
ipc::restore_album,
ipc::purge_album,
ipc::purge_all_trash,
```

- [ ] **Step 4: 构建验证**

```bash
cargo build 2>&1 | grep "error"
```

Expected: 无 error。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): add album summaries and trash commands"
```

---

## Task 3: 前端类型、API、Store

**Files:**
- Modify: `src/types.ts`
- Modify: `src/api.ts`
- Modify: `src/store.ts`

- [ ] **Step 1: 更新 `src/types.ts` 的 `Album` 类型，并新增 `AlbumSummary`**

将现有 `Album` 替换为：

```ts
export type Album = {
  id: number;
  name: string;
  created_at: string;
  is_deleted: number;
  deleted_at: string | null;
};

export type AlbumSummary = {
  id: number;
  name: string;
  created_at: string;
  is_deleted: number;
  deleted_at: string | null;
  total: number;
  cover_paths: string[];
};
```

- [ ] **Step 2: 在 `src/api.ts` 新增 5 个调用**

在 `albumRemove` 之后追加：

```ts
getAlbumSummaries: () => invoke<AlbumSummary[]>("get_album_summaries"),
listTrashAlbums: () => invoke<Album[]>("list_trash_albums"),
restoreAlbum: (id: number) => invoke<void>("restore_album", { id }),
purgeAlbum: (id: number) => invoke<void>("purge_album", { id }),
purgeAllTrash: () => invoke<void>("purge_all_trash"),
```

在文件顶部 import 中补充 `AlbumSummary`：

```ts
import type {
  Album,
  AlbumSummary,
  // ...其余保持不变
} from "./types";
```

- [ ] **Step 3: 在 `src/store.ts` 新增 trash 状态与 actions**

在 `AppState` type 的 `albums: Album[];` 下方追加：

```ts
albumSummaries: AlbumSummary[];
trashedAlbums: Album[];
refreshAlbumSummaries: () => Promise<void>;
refreshTrash: () => Promise<void>;
restoreAlbum: (id: number) => Promise<void>;
purgeAlbum: (id: number) => Promise<void>;
purgeAllTrash: () => Promise<void>;
```

在 `create` 的初始值区域（`albums: [],` 附近）追加：

```ts
albumSummaries: [],
trashedAlbums: [],
```

在 `refreshAlbums` action 实现之后追加：

```ts
refreshAlbumSummaries: async () => {
  const list = await api.getAlbumSummaries().catch(() => []);
  set({ albumSummaries: list });
},

refreshTrash: async () => {
  const list = await api.listTrashAlbums().catch(() => []);
  set({ trashedAlbums: list });
},

restoreAlbum: async (id) => {
  await api.restoreAlbum(id);
  await Promise.all([get().refreshAlbums(), get().refreshAlbumSummaries(), get().refreshTrash()]);
},

purgeAlbum: async (id) => {
  await api.purgeAlbum(id);
  await get().refreshTrash();
},

purgeAllTrash: async () => {
  await api.purgeAllTrash();
  await get().refreshTrash();
},
```

在 `AppState` type 顶部 import 中补充 `AlbumSummary`：

```ts
import type {
  Album,
  AlbumSummary,
  // ...其余保持不变
} from "./types";
```

- [ ] **Step 4: 在 `App.tsx` 的初始化 `useEffect` 中追加 `refreshAlbumSummaries` 调用**

找到现有的：
```ts
const { refreshAssets, refreshFacets, refreshPresets, refreshUserLuts, refreshAlbums, setCoverDir } = useStore.getState();
```
改为：
```ts
const { refreshAssets, refreshFacets, refreshPresets, refreshUserLuts, refreshAlbums, refreshAlbumSummaries, setCoverDir } = useStore.getState();
```
并在 `refreshAlbums();` 下方追加：
```ts
refreshAlbumSummaries();
```

- [ ] **Step 5: TypeScript 检查**

```bash
pnpm build 2>&1 | grep -E "error TS"
```

Expected: 无 TS error。

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/api.ts src/store.ts src/App.tsx
git commit -m "feat(store): add album summaries and trash state/actions"
```

---

## Task 4: i18n 翻译键

**Files:**
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 1: 在 `src/i18n/zh.ts` 的 `folder` 节点后追加 `nav` 和 `trash` 节点**

在 `folder: { ... },` 之后插入：

```ts
nav: {
  localProjects: "本地项目",
  trash: "回收站",
},
trash: {
  title: "回收站",
  empty: "回收站是空的",
  totalCount: "共 {{count}} 个项目",
  selectedCount: "已选 {{count}} 项",
  daysLeft: "还剩 {{days}} 天",
  selectAll: "全选",
  restore: "还原",
  purge: "彻底删除",
  clearAll: "清空回收站",
  confirmPurgeTitle: "您确定要彻底删除所选项目吗？",
  confirmPurgeBody: "彻底删除项目后将无法还原，是否继续？",
  confirmClearTitle: "您确定要清空回收站吗？",
  confirmClearBody: "清空后所有项目将无法还原，是否继续？",
  cancel: "取消",
  delete: "删除",
},
projects: {
  title: "本地项目",
  newProject: "新建项目",
  namePlaceholder: "请输入项目名称",
  nameExists: "项目名称已存在",
  save: "保存",
  rename: "重命名",
  delete: "删除",
  sortLastOpened: "上次打开时间",
  sortName: "名称",
  noProjects: "还没有项目，点击 + 新建",
},
```

- [ ] **Step 2: 在 `src/i18n/en.ts` 追加对应英文键**

```ts
nav: {
  localProjects: "Local Projects",
  trash: "Trash",
},
trash: {
  title: "Trash",
  empty: "Trash is empty",
  totalCount: "{{count}} items",
  selectedCount: "{{count}} selected",
  daysLeft: "{{days}} days left",
  selectAll: "Select All",
  restore: "Restore",
  purge: "Delete Permanently",
  clearAll: "Empty Trash",
  confirmPurgeTitle: "Permanently delete selected items?",
  confirmPurgeBody: "This cannot be undone. Continue?",
  confirmClearTitle: "Empty the trash?",
  confirmClearBody: "All items will be permanently deleted. Continue?",
  cancel: "Cancel",
  delete: "Delete",
},
projects: {
  title: "Local Projects",
  newProject: "New Project",
  namePlaceholder: "Enter project name",
  nameExists: "Project name already exists",
  save: "Save",
  rename: "Rename",
  delete: "Delete",
  sortLastOpened: "Last Opened",
  sortName: "Name",
  noProjects: "No projects yet. Click + to create one.",
},
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(i18n): add nav, trash, projects translation keys"
```

---

## Task 5: 安装 react-router-dom 并重构 App.tsx

**Files:**
- Modify: `package.json` (via pnpm)
- Modify: `src/App.tsx`

- [ ] **Step 1: 安装依赖**

```bash
pnpm add react-router-dom@^6.26.0
pnpm add -D @types/react-router-dom@^5.3.3
```

- [ ] **Step 2: 将 `src/App.tsx` 改为路由布局**

用以下内容完整替换 `App.tsx`：

```tsx
import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { NavSidebar } from "@/components/NavSidebar";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { EditorPage } from "@/pages/EditorPage";
import { TrashPage } from "@/pages/TrashPage";
import { Toaster } from "@/components/ui/toast";
import { UpdaterBootstrap } from "@/components/UpdaterBootstrap";
import { useStore } from "@/store";
import { api } from "@/api";

export default function App() {
  useEffect(() => {
    api.getSetting("ui.theme").then((raw) => {
      if (raw && JSON.parse(raw) === "dark") {
        document.documentElement.classList.add("dark");
      }
    }).catch(() => {});
    api.getSetting("ui.language").then((raw) => {
      if (raw) {
        const lang = JSON.parse(raw);
        if (lang === "en" || lang === "zh") {
          import("@/i18n").then(({ default: i18n }) => i18n.changeLanguage(lang));
        }
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const { refreshAssets, refreshFacets, refreshPresets, refreshUserLuts,
            refreshAlbums, refreshAlbumSummaries, setCoverDir } = useStore.getState();
    refreshAssets();
    refreshFacets();
    refreshPresets();
    refreshUserLuts();
    refreshAlbums();
    refreshAlbumSummaries();
    api.getCoverDir().then(setCoverDir).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const pendingIds = new Set<number>();
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    listen<{ asset_id: number }>("thumbnail:done", (e) => {
      if (cancelled) return;
      pendingIds.add(e.payload.asset_id);
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = setTimeout(async () => {
        if (cancelled) return;
        const ids = [...pendingIds];
        pendingIds.clear();
        const updates = await Promise.all(ids.map((id) => api.getAsset(id).catch(() => null)));
        const valid = updates.filter((a): a is NonNullable<typeof a> => a !== null);
        if (valid.length > 0) useStore.getState().batchPatchAssets(valid);
      }, 200);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      if (batchTimer) clearTimeout(batchTimer);
      unlisten?.();
    };
  }, []);

  return (
    <BrowserRouter>
      <div className="h-full w-full flex bg-zinc-950 text-zinc-200">
        <NavSidebar />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <Routes>
            <Route path="/" element={<Navigate to="/projects" replace />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:folderId" element={<EditorPage />} />
            <Route path="/trash" element={<TrashPage />} />
          </Routes>
        </div>
      </div>
      <Toaster />
      <UpdaterBootstrap />
    </BrowserRouter>
  );
}
```

- [ ] **Step 3: TypeScript 检查（页面组件尚未创建，预期有 import 错误，先确认路由结构无误）**

```bash
pnpm build 2>&1 | grep "error TS" | head -20
```

Expected: 只有找不到 `NavSidebar`/`ProjectsPage`/`EditorPage`/`TrashPage` 的 import 错误，无其他 TS 错误。

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx package.json pnpm-lock.yaml
git commit -m "feat(router): introduce BrowserRouter and page-level routing"
```

---

## Task 6: NavSidebar 组件

**Files:**
- Create: `src/components/NavSidebar.tsx`

- [ ] **Step 1: 创建 `src/components/NavSidebar.tsx`**

```tsx
import { FolderOpen, Trash2 } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";

export function NavSidebar() {
  const { t } = useTranslation();

  return (
    <aside className="w-[200px] flex-shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800/60 py-3 px-2">
      <NavItem to="/projects" icon={<FolderOpen size={15} />} label={t("nav.localProjects")} />
      <NavItem to="/trash" icon={<Trash2 size={15} />} label={t("nav.trash")} />
    </aside>
  );
}

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
}

export function NavItem({ to, icon, label }: NavItemProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        clsx(
          "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors",
          isActive
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
        )
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/NavSidebar.tsx
git commit -m "feat(ui): add NavSidebar with local projects and trash links"
```


---

## Task 7: ProjectsPage

**Files:**
- Create: `src/pages/ProjectsPage.tsx`

- [ ] **Step 1: 创建 `src/pages/ProjectsPage.tsx`**

```tsx
import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, MoreHorizontal } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "@/store";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "react-i18next";
import type { AlbumSummary } from "@/types";

export function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const albumSummaries = useStore((s) => s.albumSummaries);
  const refreshAlbumSummaries = useStore((s) => s.refreshAlbumSummaries);
  const refreshAlbums = useStore((s) => s.refreshAlbums);

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newNameError, setNewNameError] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<AlbumSummary | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState("");

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const exists = await api.checkAlbumNameExists(name);
    if (exists) { setNewNameError(t("projects.nameExists")); return; }
    const album = await api.createAlbum(name);
    setNewName(""); setNewOpen(false); setNewNameError("");
    await Promise.all([refreshAlbums(), refreshAlbumSummaries()]);
    navigate(`/projects/${album.id}`);
  }

  async function handleRename() {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name) return;
    const exists = await api.checkAlbumNameExists(name, renameTarget.id);
    if (exists) { setRenameError(t("projects.nameExists")); return; }
    await api.renameAlbum(renameTarget.id, name);
    setRenameOpen(false); setRenameTarget(null);
    await Promise.all([refreshAlbums(), refreshAlbumSummaries()]);
  }

  async function handleDelete(summary: AlbumSummary) {
    await api.deleteFolder(summary.id);
    await Promise.all([refreshAlbums(), refreshAlbumSummaries()]);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-zinc-950">
      <div className="px-6 py-4 border-b border-zinc-800/60 flex items-center justify-between">
        <h1 className="text-base font-medium text-zinc-100">{t("projects.title")}</h1>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
          <NewProjectCard onClick={() => { setNewName(""); setNewNameError(""); setNewOpen(true); }} />
          {albumSummaries.map((s) => (
            <ProjectCard
              key={s.id}
              summary={s}
              onClick={() => navigate(`/projects/${s.id}`)}
              onRename={() => { setRenameTarget(s); setRenameName(s.name); setRenameError(""); setRenameOpen(true); }}
              onDelete={() => handleDelete(s)}
              renameLabel={t("projects.rename")}
              deleteLabel={t("projects.delete")}
            />
          ))}
        </div>
        {albumSummaries.length === 0 && (
          <p className="text-zinc-500 text-sm text-center mt-16">{t("projects.noProjects")}</p>
        )}
      </div>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogTitle>{t("projects.newProject")}</DialogTitle>
          <Input
            className="mt-3"
            placeholder={t("projects.namePlaceholder")}
            maxLength={40}
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setNewNameError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          />
          {newNameError && <p className="text-xs text-destructive mt-1">{newNameError}</p>}
          <div className="mt-4 flex justify-end">
            <Button onClick={handleCreate} disabled={!newName.trim()}>{t("projects.save")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogTitle>{t("projects.rename")}</DialogTitle>
          <Input
            className="mt-3"
            placeholder={t("projects.namePlaceholder")}
            maxLength={40}
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
    </div>
  );
}

function NewProjectCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="aspect-[4/3] rounded-xl border-2 border-dashed border-zinc-700 hover:border-zinc-500 flex items-center justify-center transition-colors"
    >
      <Plus size={32} className="text-zinc-600" />
    </button>
  );
}

interface ProjectCardProps {
  summary: AlbumSummary;
  onClick: () => void;
  onRename: () => void;
  onDelete: () => void;
  renameLabel: string;
  deleteLabel: string;
}

export function ProjectCard({ summary, onClick, onRename, onDelete, renameLabel, deleteLabel }: ProjectCardProps) {
  const covers = summary.cover_paths.slice(0, 4);

  return (
    <div
      className="rounded-xl bg-zinc-900 hover:bg-zinc-800/80 cursor-pointer overflow-hidden group relative"
      onClick={onClick}
    >
      <div className="grid grid-cols-2 aspect-[4/3]">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-zinc-800 overflow-hidden">
            {covers[i] ? (
              <img
                src={convertFileSrc(covers[i])}
                className="w-full h-full object-cover"
                alt=""
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="px-3 py-2">
        <p className="text-sm font-medium text-zinc-100 truncate">{summary.name}</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          {new Date(summary.created_at).toLocaleDateString("zh-CN")}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button
            size="icon"
            variant="ghost"
            className="absolute top-2 right-2 h-6 w-6 opacity-0 group-hover:opacity-100"
          >
            <MoreHorizontal size={13} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onRename(); }}>
            {renameLabel}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            {deleteLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/ProjectsPage.tsx
git commit -m "feat(ui): add ProjectsPage with folder grid and create/rename/delete"
```


---

## Task 8: EditorPage

**Files:**
- Create: `src/pages/EditorPage.tsx`

- [ ] **Step 1: 创建 `src/pages/EditorPage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { AssetList } from "@/components/AssetList";
import { PreviewPanel } from "@/components/PreviewPanel";
import { FilterPanel } from "@/components/FilterPanel";
import { ExportDialog } from "@/components/ExportDialog";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";

export function EditorPage() {
  const { folderId } = useParams<{ folderId: string }>();
  const navigate = useNavigate();
  const enterFolder = useStore((s) => s.enterFolder);
  const exitFolder = useStore((s) => s.exitFolder);
  const albums = useStore((s) => s.albums);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    if (!folderId) return;
    const id = Number(folderId);
    const album = albums.find((a) => a.id === id);
    const name = album?.name ?? String(id);
    enterFolder(id, name);
    return () => { exitFolder(); };
  }, [folderId]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-zinc-950">
      <div className="flex-shrink-0 border-b border-zinc-800/60 bg-zinc-950/50 flex items-center">
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 ml-2 flex-shrink-0"
          onClick={() => navigate("/projects")}
        >
          <ArrowLeft size={15} />
        </Button>
        <div className="flex-1">
          <Sidebar />
        </div>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="w-[360px] flex-shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800/60 overflow-hidden">
          <AssetList />
        </div>
        <div className="flex-1 flex flex-col min-w-0 bg-zinc-950">
          <PreviewPanel onExport={() => setExportOpen(true)} />
        </div>
        <div className="w-[320px] flex-shrink-0 flex flex-col bg-zinc-950/50 border-l border-zinc-800/60 overflow-hidden">
          <FilterPanel />
        </div>
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/EditorPage.tsx
git commit -m "feat(ui): add EditorPage wrapping existing three-panel layout"
```

---

## Task 9: TrashPage

**Files:**
- Create: `src/pages/TrashPage.tsx`

- [ ] **Step 1: 创建 `src/pages/TrashPage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";
import type { Album } from "@/types";

function daysLeft(deletedAt: string | null): number {
  if (!deletedAt) return 30;
  const deleted = new Date(deletedAt).getTime();
  const expiry = deleted + 30 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((expiry - Date.now()) / (24 * 60 * 60 * 1000)));
}

export function TrashPage() {
  const { t } = useTranslation();
  const trashedAlbums = useStore((s) => s.trashedAlbums);
  const refreshTrash = useStore((s) => s.refreshTrash);
  const restoreAlbum = useStore((s) => s.restoreAlbum);
  const purgeAlbum = useStore((s) => s.purgeAlbum);
  const purgeAllTrash = useStore((s) => s.purgeAllTrash);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmPurgeOpen, setConfirmPurgeOpen] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  useEffect(() => { refreshTrash(); }, []);

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === trashedAlbums.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(trashedAlbums.map((a) => a.id)));
    }
  }

  async function handleRestore() {
    await Promise.all([...selectedIds].map((id) => restoreAlbum(id)));
    setSelectedIds(new Set());
  }

  async function handlePurge() {
    await Promise.all([...selectedIds].map((id) => purgeAlbum(id)));
    setSelectedIds(new Set());
    setConfirmPurgeOpen(false);
  }

  async function handleClearAll() {
    await purgeAllTrash();
    setSelectedIds(new Set());
    setConfirmClearOpen(false);
  }

  const hasSelection = selectedIds.size > 0;
  const allSelected = trashedAlbums.length > 0 && selectedIds.size === trashedAlbums.length;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-zinc-950">
      <div className="px-6 py-4 border-b border-zinc-800/60 flex items-center justify-between">
        <h1 className="text-base font-medium text-zinc-100">{t("trash.title")}</h1>
        <div className="flex items-center gap-3">
          {hasSelection ? (
            <>
              <label className="flex items-center gap-1.5 text-sm text-zinc-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  className="accent-blue-500"
                />
                {t("trash.selectAll")}
              </label>
              <span className="text-sm text-zinc-400">
                {t("trash.selectedCount", { count: selectedIds.size })}
              </span>
              <Button size="sm" variant="outline" onClick={handleRestore}>
                {t("trash.restore")}
              </Button>
              <Button size="sm" variant="destructive" onClick={() => setConfirmPurgeOpen(true)}>
                {t("trash.purge")}
              </Button>
            </>
          ) : (
            <>
              <span className="text-sm text-zinc-500">
                {t("trash.totalCount", { count: trashedAlbums.length })}
              </span>
              {trashedAlbums.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => setConfirmClearOpen(true)}>
                  {t("trash.clearAll")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {trashedAlbums.length === 0 ? (
          <p className="text-zinc-500 text-sm text-center mt-16">{t("trash.empty")}</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
            {trashedAlbums.map((album) => (
              <TrashCard
                key={album.id}
                album={album}
                selected={selectedIds.has(album.id)}
                onToggle={() => toggleSelect(album.id)}
                daysLeftValue={daysLeft(album.deleted_at)}
              />
            ))}
          </div>
        )}
      </div>

      <Dialog open={confirmPurgeOpen} onOpenChange={setConfirmPurgeOpen}>
        <DialogContent>
          <DialogTitle>{t("trash.confirmPurgeTitle")}</DialogTitle>
          <p className="text-sm text-zinc-400 mt-2">{t("trash.confirmPurgeBody")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmPurgeOpen(false)}>{t("trash.cancel")}</Button>
            <Button variant="destructive" onClick={handlePurge}>{t("trash.delete")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <DialogContent>
          <DialogTitle>{t("trash.confirmClearTitle")}</DialogTitle>
          <p className="text-sm text-zinc-400 mt-2">{t("trash.confirmClearBody")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmClearOpen(false)}>{t("trash.cancel")}</Button>
            <Button variant="destructive" onClick={handleClearAll}>{t("trash.delete")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface TrashCardProps {
  album: Album;
  selected: boolean;
  onToggle: () => void;
  daysLeftValue: number;
}

export function TrashCard({ album, selected, onToggle, daysLeftValue }: TrashCardProps) {
  const { t } = useTranslation();
  return (
    <div
      onClick={onToggle}
      className={`rounded-xl bg-zinc-900 cursor-pointer overflow-hidden border-2 transition-colors ${
        selected ? "border-blue-500" : "border-transparent hover:border-zinc-700"
      }`}
    >
      <div className="aspect-[4/3] bg-zinc-800 flex items-center justify-center text-zinc-600 text-xs">
        {t("trash.totalCount", { count: 0 })}
      </div>
      <div className="px-3 py-2">
        <p className="text-sm font-medium text-zinc-100 truncate">{album.name}</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          {t("trash.daysLeft", { days: daysLeftValue })}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/TrashPage.tsx
git commit -m "feat(ui): add TrashPage with restore/purge/clear-all"
```

---

## Task 10: 最终整合验证

**Files:** 无新文件，验证整体

- [ ] **Step 1: TypeScript 全量检查**

```bash
pnpm build 2>&1 | grep "error TS"
```

Expected: 无 TS error。

- [ ] **Step 2: Rust 全量检查**

```bash
cargo clippy --all-targets --all-features -- -D warnings 2>&1 | grep "^error"
```

Expected: 无 error。

- [ ] **Step 3: 删除已废弃的 `FolderList` 组件（现已被 ProjectsPage 替代）**

删除文件 `src/components/FolderList.tsx`，并检查是否还有其他地方引用它：

```bash
grep -r "FolderList" src/ --include="*.tsx" --include="*.ts"
```

若有引用，逐一移除。

- [ ] **Step 4: 最终 lint 检查**

```bash
pnpm lint 2>&1 | grep -E "error|Error"
```

Expected: 无 error。

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: folder page routing and trash — complete integration"
```


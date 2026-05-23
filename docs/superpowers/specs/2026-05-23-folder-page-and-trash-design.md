---
name: folder-page-and-trash
description: 将文件夹功能改为独立页面，并新增回收站功能
metadata:
  type: project
---

# 文件夹独立页面 + 回收站功能设计

## 背景

当前文件夹列表（`FolderList`）嵌在主界面左侧面板中，与素材编辑三栏布局共用同一个容器。
本次改造目标：
1. 将文件夹管理提升为独立的全屏页面（`/projects`）
2. 新增回收站页面（`/trash`），支持软删除、恢复、永久删除

## 路由结构

使用 `react-router-dom` 的 `BrowserRouter`（Tauri 生产包需在 `vite.config.ts` 配置 `base: '/'`）。

```
/                    → 重定向到 /projects
/projects            → 本地项目页（文件夹网格）
/projects/:folderId  → 素材编辑页（三栏布局）
/trash               → 回收站页
```

## 整体布局

```
App（BrowserRouter）
└── 全局布局（flex-row，h-full）
    ├── NavSidebar（左侧固定导航，所有路由共享，w-[200px]）
    └── 主内容区（flex-1）
        ├── /projects        → <ProjectsPage>
        ├── /projects/:id    → <EditorPage>
        └── /trash           → <TrashPage>
```

顶部工具栏（`Sidebar` 组件，含搜索/筛选）**仅在 `EditorPage` 内渲染**，不出现在其他页面。

## 组件清单

| 组件 | 路径 | 说明 |
|---|---|---|
| `NavSidebar` | `src/components/NavSidebar.tsx` | 左侧导航，替换现有布局中的导航部分 |
| `ProjectsPage` | `src/pages/ProjectsPage.tsx` | 文件夹网格页 |
| `EditorPage` | `src/pages/EditorPage.tsx` | 现有三栏布局，含顶部工具栏 |
| `TrashPage` | `src/pages/TrashPage.tsx` | 回收站页 |

## 数据层变更

### 数据库迁移（`src-tauri/src/db/mod.rs`）

在增量迁移列表追加：
```sql
ALTER TABLE albums ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0
ALTER TABLE albums ADD COLUMN deleted_at TEXT
```

### `db/albums.rs` 变更

- `Album` 结构体新增字段：`is_deleted: i64`、`deleted_at: Option<String>`
- `list()` 加 `WHERE is_deleted = 0`
- `delete()` / `delete_with_assets()` 改为软删除：
  `UPDATE albums SET is_deleted=1, deleted_at=datetime('now') WHERE id=?`
  不删除资产文件，不删除 assets 表记录，不删除 album_assets 关联
- 新增 `list_trash()` → `SELECT * FROM albums WHERE is_deleted = 1 ORDER BY deleted_at DESC`
- 新增 `restore(id)` → `UPDATE albums SET is_deleted=0, deleted_at=NULL WHERE id=?`
- 新增 `purge(id)` → `DELETE FROM albums WHERE id=?`（级联清理 album_assets，不动 assets）
- 新增 `purge_all()` → `DELETE FROM albums WHERE is_deleted=1`

### `ipc.rs` 新增命令

- `list_trash_albums`
- `restore_album(id: i64)`
- `purge_album(id: i64)`
- `purge_all_trash()`

### `src/types.ts`

`Album` 新增：
```ts
is_deleted: number;
deleted_at: string | null;
```

### `src/api.ts`

新增四个调用：
```ts
listTrashAlbums()
restoreAlbum(id: number)
purgeAlbum(id: number)
purgeAllTrash()
```

### `src/store.ts`

新增状态与 action：
- `trashedAlbums: Album[]`
- `refreshTrash(): Promise<void>`
- `restoreAlbum(id: number): Promise<void>` — 调用 api 后同时刷新 albums + trash
- `purgeAlbum(id: number): Promise<void>`
- `purgeAllTrash(): Promise<void>`

## UI 页面细节

### NavSidebar

- 固定宽度，深色背景，与现有侧边栏风格一致
- 导航项：
  - **本地项目**（图标 `FolderOpen`）→ `/projects`
  - **回收站**（图标 `Trash2`）→ `/trash`
- 当前路由匹配时高亮（`bg-zinc-800` 或主题色背景）

### ProjectsPage（`/projects`）

- 顶部：标题"本地项目" + 右上角排序下拉（"上次打开时间"等）
- 内容区：文件夹卡片网格
  - 第一张：新建占位卡（`+` 图标），点击弹出新建弹框
  - 后续卡片：4 格缩略图拼贴（取文件夹内前 4 张资产 `cover_path`）、文件夹名、更新时间、角标（"已修改 X 张，共 Y 张"）
  - hover 时显示 `...` 菜单：重命名、删除（移入回收站）
  - 点击卡片 → 跳转 `/projects/:folderId`
- 新建弹框：输入名称（最多 40 字），保存按钮

### EditorPage（`/projects/:folderId`）

- 顶部：`Sidebar` 工具栏（搜索/筛选/导出）
- 左上角：返回按钮（`←`），点击回到 `/projects`
- `useEffect` 根据路由参数 `folderId` 调用 `enterFolder(id, name)`
- 三栏布局：`AssetList` + `PreviewPanel` + `FilterPanel`（与现有完全一致）

### TrashPage（`/trash`）

**默认状态（无选中）：**
- 顶部：标题"回收站" + 右上角"共 N 个项目"文字 + "清空回收站"按钮
- 文件夹卡片：4 格缩略图、文件夹名、"还剩 X 天"（`deleted_at` + 30 天 - 今天）
- 点击卡片切换选中状态

**有选中时：**
- 右上角变为：全选复选框 + "已选 N 项" + "还原"按钮 + "彻底删除"按钮
- 选中卡片显示蓝色边框高亮（项目主题色）

**彻底删除确认弹框：**
- 标题："您确定要彻底删除所选项目吗？"
- 内容："彻底删除项目后将无法还原，是否继续？"
- 按钮：取消 / 删除（红色）

**清空回收站：**
- 直接调用 `purgeAllTrash()`，无需逐个选中
- 同样弹确认框

## 约束

- 永久删除只删数据库记录（`albums` + `album_assets`），**不删除物理文件**，也不删除 `assets` 表记录
- 回收站内文件夹的资产在主库中仍然存在，只是不再属于任何相册
- 单文件行数不超过 500 行，超出时拆分子组件

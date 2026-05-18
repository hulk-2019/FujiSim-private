# 文件夹导航功能设计文档

**日期**：2026-05-18  
**状态**：待实现

---

## 1. 背景与目标

现有"相册（Album）"功能以顶部 Select 下拉形式呈现，交互层级浅、无法支撑文件夹式导航体验。本次将相册升级为"文件夹"概念，改为左侧面板导航，并约束导入操作必须在进入文件夹后才可进行。

**不改动后端数据库表结构**，`albums` 表复用，仅新增两个 IPC 命令。

---

## 2. 方案选择

采用**方案 A：纯前端导航状态，复用现有 Album 后端**。

- 后端改动最小（仅新增 `check_album_name_exists`、`rename_album` 两条命令）
- 前端通过 `currentFolderId` 状态驱动左列视图切换
- 数据库表名 `albums` 保持不变，UI 文案全部改为"文件夹"

---

## 3. 后端变更（Rust）

### 3.1 新增 DB 函数（`src-tauri/src/db/albums.rs`）

```rust
// 检查名称是否已存在，exclude_id 用于重命名时排除自身
pub async fn name_exists(pool: &SqlitePool, name: &str, exclude_id: Option<i64>) -> Result<bool>

// 重命名文件夹
pub async fn rename(pool: &SqlitePool, id: i64, name: &str) -> Result<Album>
```

### 3.2 新增 IPC 命令（`src-tauri/src/ipc.rs`）

```rust
#[tauri::command]
pub async fn check_album_name_exists(
    state: State<'_, SharedState>,
    name: String,
    exclude_id: Option<i64>,
) -> Result<bool>

#[tauri::command]
pub async fn rename_album(
    state: State<'_, SharedState>,
    id: i64,
    name: String,
) -> Result<Album>
```

两个命令均需注册到 `lib.rs` 的 `invoke_handler`。

---

## 4. 前端变更

### 4.1 api.ts

新增两个方法：

```ts
checkAlbumNameExists: (name: string, excludeId?: number | null) => invoke<boolean>(...)
renameAlbum: (id: number, name: string) => invoke<Album>(...)
```

### 4.2 store.ts

**新增状态字段**：

```ts
currentFolderId: number | null      // null = 文件夹列表视图
currentFolderName: string | null    // 用于面包屑显示
```

**新增 actions**：

```ts
enterFolder: (id: number, name: string) => void
// 内部调用 setQuery({ album_id: id }) 触发资产刷新

exitFolder: () => void
// 内部调用 setQuery({ album_id: null })，清空 currentFolderId/Name
```

**移除**：`albums` 相关字段和 `refreshAlbums` 保持不变，供 `FolderList` 使用。

### 4.3 App.tsx

左列条件渲染：

```tsx
{currentFolderId === null ? <FolderList /> : <AssetGrid />}
```

### 4.4 新组件：FolderList（`src/components/FolderList.tsx`）

**布局**：

```
┌─────────────────────────────────┐
│ [搜索框 (本地过滤)]    [+ icon] │  ← 顶部工具栏
├─────────────────────────────────┤
│ 📁 文件夹 A              ⋯     │
│ 📁 文件夹 B              ⋯     │
│ ...（虚拟滚动）                 │
└─────────────────────────────────┘
```

**功能细节**：

- 搜索框：本地过滤，全量加载文件夹列表后在内存中过滤（文件夹数量远小于资产，全量加载合理）
- 虚拟滚动：列表渲染使用虚拟滚动，但数据源为全量加载（一次性拉取所有文件夹，不分页）
- 每行右侧 `⋯` 菜单：重命名、删除
- 点击行 → 调用 `enterFolder(id, name)`
- 新建按钮 → 打开新建弹框

**新建文件夹弹框**：

- 输入框 + 确认/取消按钮
- 提交前调用 `api.checkAlbumNameExists(name)` 校验
- 重名时输入框下方显示错误提示"文件夹名称已存在"，阻止提交

**重命名弹框**：

- 输入框预填当前名称
- 提交前调用 `api.checkAlbumNameExists(name, id)` 校验（排除自身）
- 重名逻辑同上

**删除**：直接调用现有 `api.deleteAlbum(id)`，删除后刷新列表。

### 4.5 AssetGrid 改造

**顶部 header 新增**（仅在 `currentFolderId !== null` 时渲染）：

```
┌─────────────────────────────────┐
│ ← 文件夹名称          [导入 ▾] │
├─────────────────────────────────┤
│ ... 资产网格 ...                │
└─────────────────────────────────┘
```

- 左侧：返回箭头（`ChevronLeft`）+ 文件夹名称，点击调用 `exitFolder()`
- 右侧：导入按钮（从 Sidebar 移入），下拉菜单保留"选择目录"/"选择文件"两项
- 导入时自动带上 `currentFolderId` 作为 `album_id`

**批量操作浮层**（`selectedIds.size > 0` 时渲染）：

- 绝对定位在左列底部，`position: absolute; bottom: 0`
- 包含：批量删除、移动按钮
- 从 AssetGrid 顶部移除这两个按钮

### 4.6 Sidebar.tsx 精简

移除：
- 导入按钮（移至 AssetGrid header）
- 相册 Select 下拉 + 新建相册按钮

保留：搜索框、相机筛选、星级筛选、排序、导出任务 Popover、设置菜单。

### 4.7 i18n 文案替换

`zh.ts` / `en.ts` 中所有 `album`/`相册` 相关 key 改为 `folder`/`文件夹`，新增以下 key：

```ts
folder: {
  title: "文件夹",
  searchPlaceholder: "搜索文件夹",
  newFolder: "新建文件夹",
  rename: "重命名",
  delete: "删除",
  namePlaceholder: "文件夹名称",
  nameExists: "文件夹名称已存在",
  backTo: "返回",
}
```

---

## 5. 查询过滤

进入文件夹后，`store.query.album_id` 自动设为当前文件夹 id，所有资产查询（`listAssets`）自动带上文件夹过滤条件，无需额外改动查询逻辑。

退出文件夹时，`album_id` 重置为 `null`，回到全量视图（但此时左列显示文件夹列表，不展示资产）。

---

## 6. 不在本次范围内

- 文件夹排序（当前按名称排序，与现有 `albums` 一致）
- 文件夹嵌套/层级
- 资产跨文件夹移动（现有 `album_add`/`album_remove` 可支持，但 UI 入口不在本次）
- 后端表重命名（`albums` → `folders`）

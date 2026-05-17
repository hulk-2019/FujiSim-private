# 设计文档：自定义字体存储迁移（IndexedDB → SQLite + 文件路径）

**日期**：2026-05-16  
**状态**：已批准

## 背景

当前自定义字体使用 IndexedDB 存储 base64 编码数据，存在以下问题：
- 字体数据以 base64 blob 形式存储，占用 IndexedDB 空间大且效率低
- 与应用其他资产（LUT、水印）的后端管理模式不一致
- 无法通过后端统一清理

目标：迁移到与 `user_luts` 完全对称的方案——Rust 后端管理文件拷贝，SQLite 存元数据（路径），前端通过 `asset://` URL 引用。

## 决策

- **存储方式**：拷贝到 app data 目录（`data_dir/fonts/`），SQLite 存路径
- **旧数据迁移**：不迁移，直接废弃 IndexedDB 数据（用户需重新导入）

---

## 第一节：数据层（后端）

### SQLite Schema

在 `src-tauri/src/db/mod.rs` 的 `SCHEMA` 常量中新增表：

```sql
CREATE TABLE IF NOT EXISTS user_fonts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    ext TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);
```

无需增量迁移（`CREATE TABLE IF NOT EXISTS` 对旧库安全）。

### 新文件：`src-tauri/src/db/user_fonts.rs`

提供四个函数，结构完全照抄 `user_luts.rs`：

- `insert(pool, name, file_path, ext) -> Result<UserFont>`：UPSERT，冲突时清除软删除标记
- `list(pool) -> Result<Vec<UserFont>>`：返回 `is_deleted=0` 的记录，按 name ASC 排序
- `delete(pool, id) -> Result<Option<String>>`：软删除，返回 `file_path` 供物理删除
- `name_exists(pool, name) -> Result<bool>`：名字唯一性校验

`UserFont` struct 字段：`id: i64 / name: String / file_path: String / ext: String / created_at: String / is_deleted: i64 / deleted_at: Option<String>`

### AppState

`src-tauri/src/state.rs`：

- 新增字段 `font_dir: PathBuf`
- `init()` 中在 `lut_dir` 之后追加：
  ```rust
  let font_dir = data_dir.join("fonts");
  std::fs::create_dir_all(&font_dir)?;
  ```
- `AppState` 结构体加入 `font_dir`

---

## 第二节：IPC 命令层（后端）

### 新增命令（`src-tauri/src/ipc.rs`）

**`import_fonts(state, paths: Vec<String>) -> Result<Vec<UserFont>>`**

- 过滤非文件路径
- 校验扩展名（ttf / otf / woff / woff2），不合法的跳过并 warn
- 用 `unique_font_dest`（参考 `unique_lut_dest`）在 `font_dir` 下选不冲突路径
- `fs::copy` 到目标路径
- 名字唯一性检查（`name_exists`），冲突时追加数字后缀
- `user_fonts::insert` 入库，失败时回滚物理文件

**`list_user_fonts(state) -> Result<Vec<UserFont>>`**

- 直接调 `user_fonts::list`

**`delete_user_font(state, id: i64) -> Result<()>`**

- 调 `user_fonts::delete` 软删除，拿到 `file_path`
- 物理删除文件，文件不存在时忽略错误

### 改造现有命令

**`clear_all_data`**

当前：清任务数据 + watermark 目录。

改造后额外执行：
1. 软删除所有 `user_fonts` 记录（`UPDATE user_fonts SET is_deleted=1, deleted_at=datetime('now')`）
2. 清空并重建 `font_dir`（`remove_dir_all` + `create_dir_all`）

**`reset_app_data`**

删除整个 `data_dir`，`font_dir` 作为子目录被一并删除，无需额外改动。

### `lib.rs` invoke_handler 注册

```rust
ipc::import_fonts,
ipc::list_user_fonts,
ipc::delete_user_font,
```

---

## 第三节：前端

### `src/types.ts`

`UserFont` 替换为后端对齐结构，移除 `data` 字段：

```ts
export type UserFont = {
  id: number;
  name: string;
  file_path: string;
  ext: string;
  created_at: string;
};
```

### `src/lib/fontManager.ts`

整体重写，移除所有 IndexedDB 代码（`openDB` / `tx` / `persistFontAdd` / `persistFontRemove` / `migrateFromLocalStorage`）：

- `registerFont(font: UserFont)`：`convertFileSrc(font.file_path)` 得到 `asset://` URL，注入 `@font-face`，family 名为 `String(font.id)`
- `unregisterFont(id: number)`：移除 `id="user-font-${id}"` 的 `<style>` 标签
- `loadPersistedFonts() -> Promise<UserFont[]>`：调 `api.listUserFonts()`，逐条 `registerFont`，返回列表

### `src/api.ts`

新增三个方法：

```ts
importFonts: (paths: string[]) => invoke<UserFont[]>("import_fonts", { paths }),
listUserFonts: () => invoke<UserFont[]>("list_user_fonts"),
deleteUserFont: (id: number) => invoke<void>("delete_user_font", { id }),
```

同时从类型导入中加入 `UserFont`。

### `src/store.ts`

- 移除 `persistFontAdd` / `persistFontRemove` 导入
- `addUserFont(font: UserFont)`：改为接收 `paths: string[]`，调 `api.importFonts(paths)`，对返回结果逐条 `registerFont` 并追加到 `userFonts`
- `removeUserFont(id: number)`：调 `api.deleteUserFont(id)`，成功后 `unregisterFont(id)` + 过滤状态

### `src/components/ClearCacheDialog.tsx`

- 移除 `clearIndexedDB()` 函数
- 移除对 `openDB` 的导入
- 移除 `handleClear` 中的 `await clearIndexedDB()` 调用
- 其余逻辑不变（`userFonts: []` 已在 `useStore.setState` 中处理）

---

## 不在范围内

- LUT 相关逻辑不变
- 旧 IndexedDB 数据不做迁移
- `WatermarkTab.tsx` 等字体选择 UI 组件不需要改动（`UserFont.id` 类型从 `string` 改为 `number`，需确认 UI 中 family 名引用是否一致）

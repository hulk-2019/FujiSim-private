# User Fonts SQLite Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将自定义字体存储从前端 IndexedDB + base64 迁移到后端 SQLite 元数据 + 文件路径方案，与现有 LUT 管理架构对齐。

**Architecture:** 后端新增 `user_fonts` 表存文件元数据，字体文件拷贝到 `data_dir/fonts/`；前端通过 `convertFileSrc` 将绝对路径转为 `asset://` URL 注入 `@font-face`；旧 IndexedDB 数据直接废弃，不做迁移。

**Tech Stack:** Rust + sqlx (SQLite), Tauri IPC, TypeScript + Zustand, `@tauri-apps/api/core` (convertFileSrc)

---

## File Map

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/db/user_fonts.rs` | 新建 | UserFont DB repository |
| `src-tauri/src/db/mod.rs` | 修改 | 注册 user_fonts 模块，SCHEMA 加表，run_migrations 加软删除列 |
| `src-tauri/src/state.rs` | 修改 | AppState 加 font_dir 字段 |
| `src-tauri/src/ipc.rs` | 修改 | 加 import_fonts / list_user_fonts / delete_user_font，改 clear_all_data |
| `src-tauri/src/lib.rs` | 修改 | invoke_handler 注册三个新命令 |
| `src/types.ts` | 修改 | UserFont 类型重写 |
| `src/lib/fontManager.ts` | 修改 | 重写，去掉 IndexedDB 逻辑 |
| `src/api.ts` | 修改 | 加三个新 IPC 调用方法 |
| `src/store.ts` | 修改 | addUserFont/removeUserFont 改为调后端 API |
| `src/components/WatermarkTab.tsx` | 修改 | importFont 改为传 paths 给 store，移除 readFile/bytesToBase64 |
| `src/components/ClearCacheDialog.tsx` | 修改 | 移除 clearIndexedDB |

---

## Task 1: 后端 DB 层 — user_fonts 表与 Repository

**Files:**
- Create: `src-tauri/src/db/user_fonts.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: 新建 `src-tauri/src/db/user_fonts.rs`**

```rust
use crate::error::Result;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserFont {
    pub id: i64,
    pub name: String,
    pub file_path: String,
    pub ext: String,
    pub created_at: String,
    pub is_deleted: i64,
    pub deleted_at: Option<String>,
}

pub async fn insert(pool: &SqlitePool, name: &str, file_path: &str, ext: &str) -> Result<UserFont> {
    sqlx::query(
        r#"INSERT INTO user_fonts (name, file_path, ext) VALUES (?, ?, ?)
           ON CONFLICT(file_path) DO UPDATE SET name = excluded.name, ext = excluded.ext, is_deleted = 0, deleted_at = NULL"#,
    )
    .bind(name)
    .bind(file_path)
    .bind(ext)
    .execute(pool)
    .await?;
    sqlx::query_as::<_, UserFont>("SELECT * FROM user_fonts WHERE file_path = ?")
        .bind(file_path)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<UserFont>> {
    sqlx::query_as::<_, UserFont>(
        "SELECT * FROM user_fonts WHERE is_deleted = 0 ORDER BY name ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT file_path FROM user_fonts WHERE id = ? AND is_deleted = 0")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    sqlx::query(
        "UPDATE user_fonts SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(row.map(|(p,)| p))
}

pub async fn name_exists(pool: &SqlitePool, name: &str) -> Result<bool> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM user_fonts WHERE name = ? AND is_deleted = 0 LIMIT 1")
            .bind(name)
            .fetch_optional(pool)
            .await?;
    Ok(row.is_some())
}

pub async fn delete_all(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "UPDATE user_fonts SET is_deleted = 1, deleted_at = datetime('now') WHERE is_deleted = 0",
    )
    .execute(pool)
    .await?;
    Ok(())
}
```

- [ ] **Step 2: 在 `src-tauri/src/db/mod.rs` 中注册模块**

在文件顶部 `pub mod watermark_presets;` 之后加一行：

```rust
pub mod user_fonts;
```

- [ ] **Step 3: 在 `src-tauri/src/db/mod.rs` 的 `SCHEMA` 常量中追加 `user_fonts` 表**

找到 `watermark_presets` 表定义末尾的 `);` 之后，追加：

```sql

-- 用户导入的自定义字体库。file_path 指向应用数据目录 fonts/ 下的副本
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

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

期望：无 error（仅允许 warning）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/user_fonts.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): 新增 user_fonts 表与 repository"
```

---

## Task 2: 后端 State — 添加 font_dir

**Files:**
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: 在 `AppState` 结构体中添加 `font_dir` 字段**

找到 `pub watermark_dir: PathBuf,` 这一行，在其后加：

```rust
pub font_dir: PathBuf,
```

- [ ] **Step 2: 在 `init()` 中初始化 `font_dir`**

找到：
```rust
let watermark_dir = data_dir.join("watermarks");
std::fs::create_dir_all(&watermark_dir)?;
```

在其后加：

```rust
let font_dir = data_dir.join("fonts");
std::fs::create_dir_all(&font_dir)?;
```

- [ ] **Step 3: 在 `Arc::new(AppState { ... })` 中加入 `font_dir`**

找到 `watermark_dir,` 那一行，在其后加：

```rust
font_dir,
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

期望：无 error。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/state.rs
git commit -m "feat(state): AppState 新增 font_dir 字段"
```

---

## Task 3: 后端 IPC — 新增字体命令

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 `src-tauri/src/ipc.rs` 的 use 列表中引入 `user_fonts`**

找到：
```rust
use crate::db::{albums, assets, presets, tasks, user_luts, watermark_presets};
```

改为：
```rust
use crate::db::{albums, assets, presets, tasks, user_fonts, user_luts, watermark_presets};
```

- [ ] **Step 2: 在 `ipc.rs` 末尾（`save_watermark_layer` 函数之前）添加字体辅助函数和三个命令**

在 `clear_all_data` 函数结束后、`save_watermark_layer` 函数之前，插入：

```rust
const ALLOWED_FONT_EXTS: &[&str] = &["ttf", "otf", "woff", "woff2"];

async fn unique_font_name(pool: &sqlx::SqlitePool, stem: &str) -> Result<String> {
    if !user_fonts::name_exists(pool, stem).await? {
        return Ok(stem.to_string());
    }
    for i in 2..1000 {
        let cand = format!("{stem}-{i}");
        if !user_fonts::name_exists(pool, &cand).await? {
            return Ok(cand);
        }
    }
    Err(AppError::other("too many fonts with the same name"))
}

fn unique_font_dest(dir: &Path, stem: &str, ext: &str) -> Result<PathBuf> {
    let primary = dir.join(format!("{stem}.{ext}"));
    if !primary.exists() {
        return Ok(primary);
    }
    for i in 2..1000 {
        let cand = dir.join(format!("{stem}-{i}.{ext}"));
        if !cand.exists() {
            return Ok(cand);
        }
    }
    Err(AppError::other("too many font files with the same name"))
}

#[tauri::command]
pub async fn import_fonts(
    state: State<'_, SharedState>,
    paths: Vec<String>,
) -> Result<Vec<user_fonts::UserFont>> {
    let mut out = Vec::with_capacity(paths.len());
    for raw in paths {
        let src = PathBuf::from(&raw);
        if !src.is_file() {
            tracing::warn!(?src, "import_fonts: skip non-file path");
            continue;
        }
        let ext = match src.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()) {
            Some(e) if ALLOWED_FONT_EXTS.contains(&e.as_str()) => e,
            _ => {
                tracing::warn!(?src, "import_fonts: unsupported extension, skip");
                continue;
            }
        };
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("font").to_string();
        let display_name = match unique_font_name(&state.pool, &stem).await {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(?src, error = %e, "import_fonts: name uniqueness check failed");
                continue;
            }
        };
        let dest = match unique_font_dest(&state.font_dir, &stem, &ext) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(?src, error = %e, "import_fonts: pick dest failed");
                continue;
            }
        };
        if let Err(e) = std::fs::copy(&src, &dest) {
            tracing::warn!(?src, ?dest, error = %e, "import_fonts: copy failed");
            continue;
        }
        let dest_str = dest.to_string_lossy().to_string();
        match user_fonts::insert(&state.pool, &display_name, &dest_str, &ext).await {
            Ok(font) => out.push(font),
            Err(e) => {
                tracing::warn!(?dest, error = %e, "import_fonts: db insert failed");
                let _ = std::fs::remove_file(&dest);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_user_fonts(state: State<'_, SharedState>) -> Result<Vec<user_fonts::UserFont>> {
    user_fonts::list(&state.pool).await
}

#[tauri::command]
pub async fn delete_user_font(state: State<'_, SharedState>, id: i64) -> Result<()> {
    if let Some(path) = user_fonts::delete(&state.pool, id).await? {
        let p = PathBuf::from(&path);
        if let Err(e) = std::fs::remove_file(&p) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e.into());
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 3: 改造 `clear_all_data`，加入字体清理逻辑**

找到现有的 `clear_all_data` 函数：

```rust
pub async fn clear_all_data(state: State<'_, SharedState>) -> Result<()> {
    tasks::clear_all(&state.pool).await?;
    if let Ok(mut cache) = state.lut_cache.lock() {
        cache.clear();
    }
    // watermarks 目录整体清空
    if state.watermark_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.watermark_dir);
        let _ = std::fs::create_dir_all(&state.watermark_dir);
    }
    Ok(())
}
```

替换为：

```rust
pub async fn clear_all_data(state: State<'_, SharedState>) -> Result<()> {
    tasks::clear_all(&state.pool).await?;
    if let Ok(mut cache) = state.lut_cache.lock() {
        cache.clear();
    }
    // watermarks 目录整体清空
    if state.watermark_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.watermark_dir);
        let _ = std::fs::create_dir_all(&state.watermark_dir);
    }
    // 软删除所有字体记录，清空 fonts 目录
    user_fonts::delete_all(&state.pool).await?;
    if state.font_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.font_dir);
        let _ = std::fs::create_dir_all(&state.font_dir);
    }
    Ok(())
}
```

- [ ] **Step 4: 在 `src-tauri/src/lib.rs` 的 `invoke_handler` 中注册三个新命令**

找到 `ipc::clear_all_data,` 这一行，在其后加：

```rust
ipc::import_fonts,
ipc::list_user_fonts,
ipc::delete_user_font,
```

- [ ] **Step 5: 编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```

期望：无 error。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): 新增 import_fonts / list_user_fonts / delete_user_font 命令，clear_all_data 加字体清理"
```

---

## Task 4: 前端类型与 API 层

**Files:**
- Modify: `src/types.ts`
- Modify: `src/api.ts`

- [ ] **Step 1: 在 `src/types.ts` 中重写 `UserFont` 类型**

找到：
```ts
/** 用户导入的字体，数据以 base64 持久化在 localStorage */
export type UserFont = {
  /** 唯一 ID，用于 @font-face family 名 */
  id: string;
  /** 文件原名，显示用 */
  name: string;
  /** base64 编码的字体文件数据 */
  data: string;
  /** 文件扩展名，用于 format() hint */
  ext: string;
};
```

替换为：

```ts
/** 用户导入的字体，元数据存 SQLite，文件复制到 data_dir/fonts/ */
export type UserFont = {
  id: number;
  name: string;
  file_path: string;
  ext: string;
  created_at: string;
};
```

- [ ] **Step 2: 在 `src/api.ts` 中引入 `UserFont` 类型**

找到：
```ts
import type {
  Album,
  ...
  UserLut,
  WatermarkPreset,
} from "./types";
```

在 `UserLut,` 后加一行：

```ts
  UserFont,
```

- [ ] **Step 3: 在 `src/api.ts` 中新增三个字体方法**

找到 `// ===== 水印自定义预设 =====` 注释之前，加入：

```ts
  // ===== 用户自定义字体库 =====
  importFonts: (paths: string[]) => invoke<UserFont[]>("import_fonts", { paths }),
  listUserFonts: () => invoke<UserFont[]>("list_user_fonts"),
  deleteUserFont: (id: number) => invoke<void>("delete_user_font", { id }),
```

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/api.ts
git commit -m "feat(frontend): UserFont 类型迁移，api 新增字体方法"
```

---

## Task 5: 前端 fontManager 重写

**Files:**
- Modify: `src/lib/fontManager.ts`

- [ ] **Step 1: 完整替换 `src/lib/fontManager.ts` 内容**

```ts
import { convertFileSrc } from "@tauri-apps/api/core";
import type { UserFont } from "@/types";
import { api } from "@/api";

const FONT_FORMAT: Record<string, string> = {
  ttf: "truetype",
  otf: "opentype",
  woff: "woff",
  woff2: "woff2",
};

export function registerFont(font: UserFont) {
  const format = FONT_FORMAT[font.ext.toLowerCase()] ?? "truetype";
  const url = convertFileSrc(font.file_path);
  const css = `
    @font-face {
      font-family: "${font.id}";
      src: url("${url}") format("${format}");
    }
  `;
  const style = document.createElement("style");
  style.id = `user-font-${font.id}`;
  style.textContent = css;
  document.head.appendChild(style);
}

export function unregisterFont(id: number) {
  document.getElementById(`user-font-${id}`)?.remove();
}

export async function loadPersistedFonts(): Promise<UserFont[]> {
  try {
    const fonts = await api.listUserFonts();
    for (const f of fonts) registerFont(f);
    return fonts;
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/fontManager.ts
git commit -m "feat(fontManager): 重写为 SQLite + asset:// URL 方案，移除 IndexedDB"
```

---

## Task 6: 前端 Store 改造

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: 更新 `store.ts` 顶部的导入**

找到：
```ts
import { registerFont, unregisterFont, persistFontAdd, persistFontRemove } from "./lib/fontManager";
```

替换为：
```ts
import { registerFont, unregisterFont } from "./lib/fontManager";
```

- [ ] **Step 2: 更新 `addUserFont` 的类型签名和实现**

找到 `addUserFont` 在 `AppState` 类型定义中的签名：
```ts
  addUserFont: (font: UserFont) => void;
```

替换为：
```ts
  addUserFont: (paths: string[]) => Promise<void>;
```

- [ ] **Step 3: 更新 `removeUserFont` 的类型签名**

找到：
```ts
  removeUserFont: (id: string) => void;
```

替换为：
```ts
  removeUserFont: (id: number) => Promise<void>;
```

- [ ] **Step 4: 更新 `addUserFont` 的实现**

找到：
```ts
  addUserFont: (font) => {
    registerFont(font);
    persistFontAdd(font);
    set({ userFonts: [...get().userFonts, font] });
  },
```

替换为：
```ts
  addUserFont: async (paths) => {
    const imported = await api.importFonts(paths);
    for (const f of imported) registerFont(f);
    set({ userFonts: [...get().userFonts, ...imported] });
  },
```

- [ ] **Step 5: 更新 `removeUserFont` 的实现**

找到：
```ts
  removeUserFont: (id) => {
    unregisterFont(id);
    persistFontRemove(id);
    set({ userFonts: get().userFonts.filter((f) => f.id !== id) });
  },
```

替换为：
```ts
  removeUserFont: async (id) => {
    await api.deleteUserFont(id);
    unregisterFont(id);
    set({ userFonts: get().userFonts.filter((f) => f.id !== id) });
  },
```

- [ ] **Step 6: Commit**

```bash
git add src/store.ts
git commit -m "feat(store): addUserFont/removeUserFont 改为调后端 API"
```

---

## Task 7: 前端 WatermarkTab 改造

**Files:**
- Modify: `src/components/WatermarkTab.tsx`

- [ ] **Step 1: 移除 `readFile` 和 `bytesToBase64` 相关导入及工具函数**

找到文件顶部的导入，移除所有 `readFile`、`bytesToBase64` 相关内容。

定位到文件顶部，找到类似：
```ts
import { readFile } from "@tauri-apps/plugin-fs";
```
或者
```ts
function bytesToBase64(bytes: Uint8Array): string {
```
将它们删除。（如果 `bytesToBase64` 定义在文件内，整个函数删掉。）

- [ ] **Step 2: 重写 `importFont` 函数**

找到：
```ts
  async function importFont() {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "Font", extensions: ["ttf", "otf", "woff", "woff2"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const p of paths) {
      const bytes = await readFile(p);
      const name = p.split("/").pop()!.replace(/\.[^.]+$/, "");
      const ext = p.split(".").pop()!.toLowerCase();
      const id = `uf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const data = bytesToBase64(bytes);
      const font: UserFont = { id, name, ext, data };
      addUserFont(font);
    }
  }
```

替换为：

```ts
  async function importFont() {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "Font", extensions: ["ttf", "otf", "woff", "woff2"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await addUserFont(paths);
  }
```

- [ ] **Step 3: 更新 `handleRemoveFont` 函数**

找到：
```ts
  function handleRemoveFont(font: UserFont) {
    if (wm.fontFamily === font.id) setWatermark({ fontFamily: "sans-serif" });
    removeUserFont(font.id);
  }
```

替换为：

```ts
  async function handleRemoveFont(font: UserFont) {
    if (wm.fontFamily === String(font.id)) setWatermark({ fontFamily: "sans-serif" });
    await removeUserFont(font.id);
  }
```

- [ ] **Step 4: 更新 `UserFontItem` 中 value 和 fontFamily 的使用**

找到：
```ts
function UserFontItem({ font, onDelete }: { font: UserFont; onDelete: () => void }) {
  return (
    <SelectItemWithDelete value={font.id} onDelete={onDelete}>
      <span style={{ fontFamily: font.id }}>{font.name}</span>
    </SelectItemWithDelete>
  );
}
```

替换为：

```ts
function UserFontItem({ font, onDelete }: { font: UserFont; onDelete: () => void }) {
  return (
    <SelectItemWithDelete value={String(font.id)} onDelete={onDelete}>
      <span style={{ fontFamily: String(font.id) }}>{font.name}</span>
    </SelectItemWithDelete>
  );
}
```

- [ ] **Step 5: 确认字体选择 Select 的 value 处理**

在 `WatermarkTab` 中搜索所有 `font.id` 的引用（用于 Select value、fontFamily 绑定等），确保全部转为 `String(font.id)`。

检查命令：
```bash
grep -n "font\.id\|fontFamily.*font" src/components/WatermarkTab.tsx
```

期望：所有 `font.id` 作为字符串使用的地方都已加 `String(...)` 或本身已是字符串上下文。

- [ ] **Step 6: Commit**

```bash
git add src/components/WatermarkTab.tsx
git commit -m "feat(WatermarkTab): importFont 改为传 paths，移除 readFile/bytesToBase64"
```

---

## Task 8: ClearCacheDialog 清理

**Files:**
- Modify: `src/components/ClearCacheDialog.tsx`

- [ ] **Step 1: 移除 `openDB` 导入**

找到：
```ts
import { openDB } from "@/lib/fontManager";
```

删除该行。

- [ ] **Step 2: 移除 `clearIndexedDB` 函数**

找到并删除：
```ts
async function clearIndexedDB() {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("fonts", "readwrite");
      const req = tx.objectStore("fonts").clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // IndexedDB 清空失败不阻断流程
  }
}
```

- [ ] **Step 3: 移除 `handleClear` 中的 `clearIndexedDB` 调用**

找到：
```ts
    try {
      await api.clearAllData();
      await clearIndexedDB();
      useStore.setState({
```

替换为：

```ts
    try {
      await api.clearAllData();
      useStore.setState({
```

- [ ] **Step 4: Commit**

```bash
git add src/components/ClearCacheDialog.tsx
git commit -m "feat(ClearCacheDialog): 移除 IndexedDB 清理逻辑，后端 clear_all_data 已处理字体清理"
```

---

## Task 9: TypeScript 编译验证

- [ ] **Step 1: 在项目根目录运行 TypeScript 类型检查**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1
```

期望：无 error。如有 `UserFont` 相关类型错误（`id` 类型不匹配、`data` 字段引用等），按错误提示修复。

- [ ] **Step 2: 运行 Rust 完整构建验证**

```bash
cd src-tauri && cargo build 2>&1 | tail -30
```

期望：编译成功，`Finished` 行出现。

- [ ] **Step 3: Commit（如有修复）**

```bash
git add -A && git commit -m "fix: 修复 UserFont 类型迁移后的编译错误"
```

---

## Task 10: Tauri capabilities 验证

- [ ] **Step 1: 检查 `src-tauri/capabilities/default.json` 是否已包含 fs 插件权限**

```bash
cat src-tauri/capabilities/default.json
```

`convertFileSrc` 需要 `asset` 协议权限（通常 Tauri 默认开启）。确认 `fs:allow-read-file` 或等价权限已存在。若不存在，参考现有 LUT 导入的权限配置补充。

- [ ] **Step 2: 确认 `asset://` 协议 scope 包含 font_dir**

在 Tauri v2 中，`convertFileSrc` 返回的 `asset://` URL 需要 `asset` 协议在 capabilities 里开放对应目录。

检查 capabilities 中是否有类似：
```json
"core:asset:default"
```
或者针对路径的 scope 配置。若 LUT 的 `asset://` 已正常工作（因为 LUT 也在 `data_dir` 下），字体同理无需额外配置。

- [ ] **Step 3: Commit（如有修改）**

```bash
git add src-tauri/capabilities/ && git commit -m "chore(capabilities): 确认 asset 协议权限覆盖 fonts 目录"
```

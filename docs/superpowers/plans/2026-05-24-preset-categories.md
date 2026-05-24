# 预设分类与 LUT 归位 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 LUT 导入入口从右侧调整面板搬到左侧预设面板，并引入「分类」概念统一组织自定义预设和导入的 LUT。

**Architecture:** 后端新增 `preset_categories` 表与 `category_id` 外键列（应用层维护，无 SQLite 外键约束），通过新增 7 个 IPC 命令暴露 CRUD；前端把 `PresetList.tsx` 重构为目录结构，`PresetListHeader` 处理搜索 + 「+」菜单，`PresetGroupedList` 按分类分组渲染统一的预设/LUT 条目，`CategoryDialog` 与 `ImportLutDialog` 处理弹框交互。

**Tech Stack:** Rust + sqlx (SQLite) + Tauri IPC，React + TypeScript + Zustand + shadcn/ui (Radix DropdownMenu/ContextMenu/Dialog) + Tailwind + lucide-react，vitest（前端测试）+ `cargo test`（后端测试）。

**Spec:** [docs/superpowers/specs/2026-05-24-preset-categories-design.md](../specs/2026-05-24-preset-categories-design.md)

---

## 全局约定

- 所有任务一律遵循 TDD：先写失败测试 → 实现 → 测试通过 → 提交。
- 单个文件硬限 500 行（项目 CLAUDE.md），每个任务结束前自查行数。
- 后端代码风格：必过 `cargo fmt --all` 与 `cargo clippy --all-targets --all-features -- -D warnings`。
- 前端：必过 `pnpm lint` 与 `pnpm tsc --noEmit`（如项目 lint 脚本未含 TS 检查）。
- 提交信息使用 Conventional Commits（`feat(...)` / `test(...)` / `refactor(...)`）。
- **提交前必跑命令**：后端任务跑 `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test -p fujisim`；前端任务跑 `pnpm lint && pnpm test --run`（vitest）。
- 任何任务结束未通过验证 → 不提交，先修问题。

---

## 文件结构总览

### 新建（后端）
- `src-tauri/src/db/preset_categories.rs` — 分类 CRUD + 单元测试

### 修改（后端）
- `src-tauri/src/db/mod.rs` — schema + 增量迁移声明
- `src-tauri/src/db/presets.rs` — 增 `category_id` 字段、`set_category` 函数
- `src-tauri/src/db/user_luts.rs` — 增 `category_id` 字段、`set_category` 函数、`insert` 接受 `category_id`
- `src-tauri/src/ipc.rs` — 新增 7 个命令、修改 3 个命令签名
- `src-tauri/src/lib.rs` — 注册新命令

### 新建（前端）
- `src/components/Editor/PresetList/index.tsx`
- `src/components/Editor/PresetList/PresetListHeader.tsx`
- `src/components/Editor/PresetList/PresetGroupedList.tsx`
- `src/components/Editor/PresetList/PresetCard.tsx`
- `src/components/Editor/PresetList/CategoryDialog.tsx`
- `src/components/Editor/PresetList/ImportLutDialog.tsx`

### 删除（前端）
- `src/components/Editor/PresetList.tsx`（被同名目录的 index.tsx 取代）

### 修改（前端）
- `src/types.ts`
- `src/api.ts`
- `src/store.ts`
- `src/components/FilterPanel.tsx` — 删除 LUT 下拉/导入入口、保存预设弹框增加分类字段
- `src/i18n/zh.ts` / `src/i18n/en.ts`
- `src/components/EditorPage.tsx` 等若有引用 `PresetList` 的地方（仅校验 import 路径）

### 测试
- `src-tauri/src/db/preset_categories.rs`（内置 `#[cfg(test)] mod tests`）
- `src/components/Editor/PresetList/__tests__/CategoryDialog.test.tsx`
- `src/components/Editor/PresetList/__tests__/PresetGroupedList.test.tsx`

---

## Phase 1：后端数据层

### Task 1: 数据库迁移与 schema

**Files:**
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1.1: 在 `SCHEMA` 常量结尾追加 `preset_categories` 表 DDL**

`src-tauri/src/db/mod.rs` 找到 `const SCHEMA: &str = r#"..."#;`，在最后一个 `CREATE TABLE` 后添加：

```sql
-- 用户自定义预设分类：统一组织 filter_presets 和 user_luts
CREATE TABLE IF NOT EXISTS preset_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_preset_categories_sort ON preset_categories(sort_order);
```

- [ ] **Step 1.2: 在 `run_migrations` 增量迁移列表中追加 `category_id` 列**

找到 `for sql in [ ... ALTER TABLE albums ADD COLUMN deleted_at TEXT, ]`（增量列声明数组），在末尾追加：

```rust
"ALTER TABLE filter_presets ADD COLUMN category_id INTEGER",
"ALTER TABLE user_luts      ADD COLUMN category_id INTEGER",
"CREATE INDEX IF NOT EXISTS idx_filter_presets_category ON filter_presets(category_id)",
"CREATE INDEX IF NOT EXISTS idx_user_luts_category      ON user_luts(category_id)",
```

注意：`CREATE INDEX IF NOT EXISTS` 与 `ALTER TABLE ADD COLUMN` 都通过现有 `let _ = sqlx::query(sql).execute(pool).await;` 容忍失败。

- [ ] **Step 1.3: 跑后端编译**

```bash
cd src-tauri && cargo build
```

预期：编译通过（此时还没有任何代码引用 `category_id`，纯 schema 迁移）。

- [ ] **Step 1.4: 提交**

```bash
git add src-tauri/src/db/mod.rs
git commit -m "feat(db): add preset_categories table and category_id columns"
```

---

### Task 2: `preset_categories` CRUD 模块

**Files:**
- Create: `src-tauri/src/db/preset_categories.rs`
- Modify: `src-tauri/src/db/mod.rs`（声明 `pub mod preset_categories;`）

- [ ] **Step 2.1: 在 `db/mod.rs` 顶部模块声明区追加**

```rust
pub mod preset_categories;
```

- [ ] **Step 2.2: 创建 `preset_categories.rs` 写失败测试**

新建 `src-tauri/src/db/preset_categories.rs`：

```rust
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

/// 用户自定义预设分类的读模型。
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PresetCategory {
    pub id: i64,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<PresetCategory>> {
    sqlx::query_as::<_, PresetCategory>(
        "SELECT * FROM preset_categories ORDER BY sort_order ASC, name ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn name_exists(
    pool: &SqlitePool,
    name: &str,
    exclude_id: Option<i64>,
) -> Result<bool> {
    let count: (i64,) = match exclude_id {
        Some(eid) => sqlx::query_as(
            "SELECT COUNT(*) FROM preset_categories WHERE name = ? AND id != ?",
        )
        .bind(name)
        .bind(eid)
        .fetch_one(pool)
        .await?,
        None => sqlx::query_as("SELECT COUNT(*) FROM preset_categories WHERE name = ?")
            .bind(name)
            .fetch_one(pool)
            .await?,
    };
    Ok(count.0 > 0)
}

pub async fn create(pool: &SqlitePool, name: &str) -> Result<PresetCategory> {
    if name_exists(pool, name, None).await? {
        return Err(AppError::other("该分类名已存在"));
    }
    let id = sqlx::query("INSERT INTO preset_categories (name) VALUES (?)")
        .bind(name)
        .execute(pool)
        .await?
        .last_insert_rowid();
    sqlx::query_as::<_, PresetCategory>("SELECT * FROM preset_categories WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn rename(pool: &SqlitePool, id: i64, name: &str) -> Result<PresetCategory> {
    if name_exists(pool, name, Some(id)).await? {
        return Err(AppError::other("该分类名已存在"));
    }
    let result = sqlx::query("UPDATE preset_categories SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound.into());
    }
    sqlx::query_as::<_, PresetCategory>("SELECT * FROM preset_categories WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// 删除分类。事务中先把 filter_presets / user_luts 的 category_id 置 NULL，
/// 再 DELETE，保证内容物只迁移分组、不删除。
pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE filter_presets SET category_id = NULL WHERE category_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE user_luts SET category_id = NULL WHERE category_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM preset_categories WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fresh_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create in-memory pool");
        sqlx::query(
            r#"
            CREATE TABLE preset_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE filter_presets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id INTEGER
            );
            CREATE TABLE user_luts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id INTEGER
            );
            "#,
        )
        .execute(&pool)
        .await
        .expect("seed schema");
        pool
    }

    #[tokio::test]
    async fn create_and_list() {
        let pool = fresh_pool().await;
        let c = create(&pool, "合照").await.expect("create");
        assert_eq!(c.name, "合照");
        let all = list(&pool).await.expect("list");
        assert_eq!(all.len(), 1);
    }

    #[tokio::test]
    async fn create_duplicate_returns_error() {
        let pool = fresh_pool().await;
        create(&pool, "合照").await.expect("create");
        let err = create(&pool, "合照").await.expect_err("should fail");
        assert!(err.to_string().contains("已存在"));
    }

    #[tokio::test]
    async fn rename_collides_with_other() {
        let pool = fresh_pool().await;
        let _a = create(&pool, "合照").await.expect("create a");
        let b = create(&pool, "胶片日记").await.expect("create b");
        let err = rename(&pool, b.id, "合照").await.expect_err("should fail");
        assert!(err.to_string().contains("已存在"));
    }

    #[tokio::test]
    async fn rename_to_self_ok() {
        let pool = fresh_pool().await;
        let a = create(&pool, "合照").await.expect("create");
        rename(&pool, a.id, "合照").await.expect("rename to self ok");
    }

    #[tokio::test]
    async fn delete_clears_foreign_refs() {
        let pool = fresh_pool().await;
        let c = create(&pool, "合照").await.expect("create");
        sqlx::query("INSERT INTO filter_presets (category_id) VALUES (?)")
            .bind(c.id)
            .execute(&pool)
            .await
            .expect("insert preset");
        sqlx::query("INSERT INTO user_luts (category_id) VALUES (?)")
            .bind(c.id)
            .execute(&pool)
            .await
            .expect("insert lut");
        delete(&pool, c.id).await.expect("delete");
        let preset_cat: (Option<i64>,) =
            sqlx::query_as("SELECT category_id FROM filter_presets LIMIT 1")
                .fetch_one(&pool)
                .await
                .expect("query preset");
        let lut_cat: (Option<i64>,) =
            sqlx::query_as("SELECT category_id FROM user_luts LIMIT 1")
                .fetch_one(&pool)
                .await
                .expect("query lut");
        assert_eq!(preset_cat.0, None);
        assert_eq!(lut_cat.0, None);
        assert!(list(&pool).await.expect("list").is_empty());
    }

    #[tokio::test]
    async fn name_exists_with_exclude() {
        let pool = fresh_pool().await;
        let a = create(&pool, "合照").await.expect("create");
        assert!(!name_exists(&pool, "合照", Some(a.id)).await.expect("check"));
        assert!(name_exists(&pool, "合照", None).await.expect("check"));
    }
}
```

- [ ] **Step 2.3: 跑测试，验证全部通过**

```bash
cd src-tauri && cargo test -p fujisim db::preset_categories
```

预期：6 个测试全部 PASS（`create_and_list / create_duplicate_returns_error / rename_collides_with_other / rename_to_self_ok / delete_clears_foreign_refs / name_exists_with_exclude`）。如果包名不是 `fujisim`，去掉 `-p fujisim` 即可。

- [ ] **Step 2.4: 跑 fmt + clippy**

```bash
cd src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings
```

预期：无 warning，无 error。

- [ ] **Step 2.5: 提交**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/db/preset_categories.rs
git commit -m "feat(db): add preset_categories CRUD with rename/delete and tests"
```

---

### Task 3: `presets.rs` 增加 `category_id` 字段与 `set_category`

**Files:**
- Modify: `src-tauri/src/db/presets.rs`

- [ ] **Step 3.1: 在 `FilterPreset` 结构体加字段**

把 `pub created_at: String,` 之前加上：

```rust
    pub category_id: Option<i64>,
```

- [ ] **Step 3.2: 在 `NewFilterPreset` 结构体加字段**

把 `pub is_builtin: bool,` 之前加上：

```rust
    pub category_id: Option<i64>,
```

- [ ] **Step 3.3: 修改 `upsert` 的 INSERT/UPDATE SQL**

把 `pub async fn upsert` 整段替换为以下版本（加入 `category_id` 列）：

```rust
pub async fn upsert(pool: &SqlitePool, p: &NewFilterPreset) -> Result<FilterPreset> {
    sqlx::query(
        r#"INSERT INTO filter_presets (name,base_simulation,grain_effect,grain_size,color_chrome_effect,highlight_tone,shadow_tone,color_saturation,clarity,sharpness,wb_shift_r,wb_shift_b,lut_file_path,is_builtin,category_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(name) DO UPDATE SET
             base_simulation=excluded.base_simulation,
             grain_effect=excluded.grain_effect,
             grain_size=excluded.grain_size,
             color_chrome_effect=excluded.color_chrome_effect,
             highlight_tone=excluded.highlight_tone,
             shadow_tone=excluded.shadow_tone,
             color_saturation=excluded.color_saturation,
             clarity=excluded.clarity,
             sharpness=excluded.sharpness,
             wb_shift_r=excluded.wb_shift_r,
             wb_shift_b=excluded.wb_shift_b,
             lut_file_path=excluded.lut_file_path,
             is_builtin=excluded.is_builtin,
             category_id=excluded.category_id"#,
    )
    .bind(&p.name)
    .bind(&p.base_simulation)
    .bind(&p.grain_effect)
    .bind(&p.grain_size)
    .bind(&p.color_chrome_effect)
    .bind(p.highlight_tone)
    .bind(p.shadow_tone)
    .bind(p.color_saturation)
    .bind(p.clarity)
    .bind(p.sharpness)
    .bind(p.wb_shift_r)
    .bind(p.wb_shift_b)
    .bind(&p.lut_file_path)
    .bind(p.is_builtin as i64)
    .bind(p.category_id)
    .execute(pool)
    .await?;
    sqlx::query_as::<_, FilterPreset>("SELECT * FROM filter_presets WHERE name = ?")
        .bind(&p.name)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}
```

- [ ] **Step 3.4: 在文件末尾追加 `set_category`**

```rust
/// 把指定预设挂到分类下，传 None 即移到「未分类」。
pub async fn set_category(
    pool: &SqlitePool,
    preset_id: i64,
    category_id: Option<i64>,
) -> Result<()> {
    sqlx::query("UPDATE filter_presets SET category_id = ? WHERE id = ?")
        .bind(category_id)
        .bind(preset_id)
        .execute(pool)
        .await?;
    Ok(())
}
```

- [ ] **Step 3.5: 找到所有调用方（13 个内置预设种子写入处）补字段**

```bash
grep -rn "NewFilterPreset" src-tauri/src
```

预期能找到种子文件（如 `src-tauri/src/processing/...` 中的 13 个内置预设构造）。在每个 `NewFilterPreset { ... }` 字面量中追加：

```rust
            category_id: None,
```

- [ ] **Step 3.6: 编译**

```bash
cd src-tauri && cargo build
```

预期：通过。如果失败，修复未补字段的调用点。

- [ ] **Step 3.7: 跑 fmt + clippy + test**

```bash
cd src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

预期：通过。

- [ ] **Step 3.8: 提交**

```bash
git add -A src-tauri/
git commit -m "feat(db): presets carry category_id and add set_category"
```

---

### Task 4: `user_luts.rs` 增加 `category_id` 字段与 `set_category`

**Files:**
- Modify: `src-tauri/src/db/user_luts.rs`

- [ ] **Step 4.1: 在 `UserLut` 结构体加字段**

`pub created_at: String,` 之前加：

```rust
    pub category_id: Option<i64>,
```

- [ ] **Step 4.2: 改造 `insert` 接受 `category_id`**

把现有 `insert` 替换为：

```rust
pub async fn insert(
    pool: &SqlitePool,
    name: &str,
    file_path: &str,
    category_id: Option<i64>,
) -> Result<UserLut> {
    sqlx::query(
        r#"INSERT INTO user_luts (name, file_path, category_id) VALUES (?, ?, ?)
           ON CONFLICT(file_path) DO UPDATE SET
             name = excluded.name,
             category_id = excluded.category_id,
             is_deleted = 0,
             deleted_at = NULL"#,
    )
    .bind(name)
    .bind(file_path)
    .bind(category_id)
    .execute(pool)
    .await?;
    sqlx::query_as::<_, UserLut>("SELECT * FROM user_luts WHERE file_path = ?")
        .bind(file_path)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}
```

- [ ] **Step 4.3: 在文件末尾追加 `set_category`**

```rust
pub async fn set_category(
    pool: &SqlitePool,
    lut_id: i64,
    category_id: Option<i64>,
) -> Result<()> {
    sqlx::query("UPDATE user_luts SET category_id = ? WHERE id = ?")
        .bind(category_id)
        .bind(lut_id)
        .execute(pool)
        .await?;
    Ok(())
}
```

- [ ] **Step 4.4: 修复 `ipc.rs` 中所有 `user_luts::insert(...)` 调用**

```bash
grep -n "user_luts::insert" src-tauri/src/ipc.rs
```

把 3 个左右的调用全部从 `user_luts::insert(&state.pool, &display_name, &dest_str)` 改为 `user_luts::insert(&state.pool, &display_name, &dest_str, category_id)`，其中 `category_id` 来自 `import_luts` / `import_luts_from_dir` 的新增参数（暂时按 `None` 占位，下一个任务接通）。先把所有调用改为 `None` 让编译通过。

- [ ] **Step 4.5: 编译**

```bash
cd src-tauri && cargo build
```

预期：通过。

- [ ] **Step 4.6: 跑 fmt + clippy + test**

```bash
cd src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

预期：通过。

- [ ] **Step 4.7: 提交**

```bash
git add -A src-tauri/
git commit -m "feat(db): user_luts carry category_id and add set_category"
```

---

## Phase 2：后端 IPC 层

### Task 5: 新增 7 条分类相关 IPC 命令

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 5.1: 在 `ipc.rs` 顶部 `use` 块加入 `preset_categories`**

把：
```rust
use crate::db::{albums, assets, presets, tasks, user_fonts, user_luts, watermark_presets};
```
改为：
```rust
use crate::db::{albums, assets, preset_categories, presets, tasks, user_fonts, user_luts, watermark_presets};
```

- [ ] **Step 5.2: 在 `ipc.rs` 末尾追加 7 个命令**

放在文件末尾（保持文件 < 500 行的话需要观察总行数；超出则该模块拆分留给 Task 13）：

```rust
// ===== 预设分类 =====

#[tauri::command]
pub async fn list_preset_categories(
    state: State<'_, SharedState>,
) -> Result<Vec<preset_categories::PresetCategory>> {
    preset_categories::list(&state.pool).await
}

#[tauri::command]
pub async fn create_preset_category(
    state: State<'_, SharedState>,
    name: String,
) -> Result<preset_categories::PresetCategory> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::other("分类名不能为空"));
    }
    preset_categories::create(&state.pool, trimmed).await
}

#[tauri::command]
pub async fn rename_preset_category(
    state: State<'_, SharedState>,
    id: i64,
    name: String,
) -> Result<preset_categories::PresetCategory> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::other("分类名不能为空"));
    }
    preset_categories::rename(&state.pool, id, trimmed).await
}

#[tauri::command]
pub async fn delete_preset_category(state: State<'_, SharedState>, id: i64) -> Result<()> {
    preset_categories::delete(&state.pool, id).await
}

#[tauri::command]
pub async fn check_preset_category_name_exists(
    state: State<'_, SharedState>,
    name: String,
    exclude_id: Option<i64>,
) -> Result<bool> {
    preset_categories::name_exists(&state.pool, name.trim(), exclude_id).await
}

#[tauri::command]
pub async fn set_preset_category(
    state: State<'_, SharedState>,
    preset_id: i64,
    category_id: Option<i64>,
) -> Result<()> {
    presets::set_category(&state.pool, preset_id, category_id).await
}

#[tauri::command]
pub async fn set_user_lut_category(
    state: State<'_, SharedState>,
    lut_id: i64,
    category_id: Option<i64>,
) -> Result<()> {
    user_luts::set_category(&state.pool, lut_id, category_id).await
}
```

- [ ] **Step 5.3: 在 `lib.rs::invoke_handler` 注册新命令**

找到 `// ===== 滤镜预设 =====` 区块，在 `ipc::delete_preset,` 之后追加：

```rust
            ipc::list_preset_categories,
            ipc::create_preset_category,
            ipc::rename_preset_category,
            ipc::delete_preset_category,
            ipc::check_preset_category_name_exists,
            ipc::set_preset_category,
            ipc::set_user_lut_category,
```

- [ ] **Step 5.4: 编译**

```bash
cd src-tauri && cargo build
```

预期：通过。

- [ ] **Step 5.5: 跑 fmt + clippy**

```bash
cd src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings
```

预期：通过。

- [ ] **Step 5.6: 提交**

```bash
git add -A src-tauri/
git commit -m "feat(ipc): expose preset_categories CRUD and category assignment"
```

---

### Task 6: `import_luts` / `import_luts_from_dir` / `save_preset` 接受 `category_id`

**Files:**
- Modify: `src-tauri/src/ipc.rs`

- [ ] **Step 6.1: `import_luts` 加参数并传给 `user_luts::insert`**

定位 `pub async fn import_luts(`，把签名改为：

```rust
#[tauri::command]
pub async fn import_luts(
    state: State<'_, SharedState>,
    paths: Vec<String>,
    category_id: Option<i64>,
) -> Result<Vec<user_luts::UserLut>> {
```

把函数体内 `user_luts::insert(&state.pool, &display_name, &dest_str)` 全部改为 `user_luts::insert(&state.pool, &display_name, &dest_str, category_id)`（每条 LUT 共享本批次 category_id）。

- [ ] **Step 6.2: `import_luts_from_dir` 同样处理**

```rust
#[tauri::command]
pub async fn import_luts_from_dir(
    state: State<'_, SharedState>,
    dir: String,
    category_id: Option<i64>,
) -> Result<Vec<user_luts::UserLut>> {
```

并把内部调用改为带 `category_id`。

- [ ] **Step 6.3: `save_preset` 透传 `category_id`**

`save_preset` 命令本身签名不动（`preset: presets::NewFilterPreset` 已包含 `category_id`），但要确认 `presets::upsert` 已经会把字段写入（Task 3.3 已做）。

- [ ] **Step 6.4: 编译 + fmt + clippy + test**

```bash
cd src-tauri && cargo build && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

预期：通过。

- [ ] **Step 6.5: 提交**

```bash
git add -A src-tauri/
git commit -m "feat(ipc): import_luts accepts category_id"
```

---

## Phase 3：前端类型与 API 层

### Task 7: `types.ts` 与 `api.ts` 扩展

**Files:**
- Modify: `src/types.ts`
- Modify: `src/api.ts`

- [ ] **Step 7.1: `types.ts` 新增 `PresetCategory` 与字段扩展**

在 `FilterPreset` 之前新增：

```ts
export type PresetCategory = {
  id: number;
  name: string;
  sort_order: number;
  created_at: string;
};
```

把 `FilterPreset` 类型的 `lut_file_path?: string | null;` 之后追加：

```ts
  category_id?: number | null;
```

把 `UserLut` 类型的 `created_at: string;` 之前追加：

```ts
  category_id?: number | null;
```

`NewFilterPreset` 已经通过 `Omit + & { is_builtin: boolean }` 自动继承 `category_id`，无需改动；但需要确认 `NewFilterPreset` 不会被 `Omit` 排除掉新字段。当前定义为 `Omit<FilterPreset, "id" | "created_at" | "is_builtin">`，`category_id` 会被保留。

- [ ] **Step 7.2: `api.ts` 引入 `PresetCategory`**

`import type` 块加入 `PresetCategory`：

```ts
import type {
  // 既有...
  PresetCategory,
} from "./types";
```

- [ ] **Step 7.3: `api.ts` 新增 7 条命令封装**

在 `// ===== 滤镜预设 CRUD =====` 区块结尾、`listFujiSimulations` 之前追加：

```ts
  listPresetCategories: () => invoke<PresetCategory[]>("list_preset_categories"),
  createPresetCategory: (name: string) =>
    invoke<PresetCategory>("create_preset_category", { name }),
  renamePresetCategory: (id: number, name: string) =>
    invoke<PresetCategory>("rename_preset_category", { id, name }),
  deletePresetCategory: (id: number) =>
    invoke<void>("delete_preset_category", { id }),
  checkPresetCategoryNameExists: (name: string, excludeId?: number | null) =>
    invoke<boolean>("check_preset_category_name_exists", {
      name,
      excludeId: excludeId ?? null,
    }),
  setPresetCategory: (presetId: number, categoryId: number | null) =>
    invoke<void>("set_preset_category", { presetId, categoryId }),
  setUserLutCategory: (lutId: number, categoryId: number | null) =>
    invoke<void>("set_user_lut_category", { lutId, categoryId }),
```

- [ ] **Step 7.4: 调整 `importLuts` / `importLutsFromDir` 签名**

```ts
  importLuts: (paths: string[], categoryId: number | null = null) =>
    invoke<UserLut[]>("import_luts", { paths, categoryId }),
  importLutsFromDir: (dir: string, categoryId: number | null = null) =>
    invoke<UserLut[]>("import_luts_from_dir", { dir, categoryId }),
```

- [ ] **Step 7.5: `pnpm tsc --noEmit`**

```bash
pnpm tsc --noEmit
```

预期：通过。已有调用 `api.importLuts(paths)`、`api.savePreset(...)` 仍然兼容（`categoryId` 默认 null；`NewFilterPreset.category_id` 是可选字段）。

- [ ] **Step 7.6: 提交**

```bash
git add src/types.ts src/api.ts
git commit -m "feat(api): add preset categories typings and IPC wrappers"
```

---

### Task 8: `store.ts` 增加 `categories` 切片

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 8.1: 顶部 import 加 `PresetCategory`**

```ts
import type {
  // 既有...
  PresetCategory,
} from "./types";
```

- [ ] **Step 8.2: 在 `AppState` 类型定义中追加切片**

放在 `albums: Album[];` 段落之后：

```ts
  // ===== 预设分类 =====
  categories: PresetCategory[];
  refreshCategories: () => Promise<void>;
  createCategory: (name: string) => Promise<PresetCategory>;
  renameCategory: (id: number, name: string) => Promise<PresetCategory>;
  deleteCategory: (id: number) => Promise<void>;
  setPresetCategory: (presetId: number, categoryId: number | null) => Promise<void>;
  setUserLutCategory: (lutId: number, categoryId: number | null) => Promise<void>;
```

- [ ] **Step 8.3: 在 store 实现里追加初值与 actions**

`presets: [],` 同级位置加：

```ts
  categories: [],
```

`refreshUserLuts: ...` 之后插入：

```ts
  refreshCategories: async () => {
    const list = await api.listPresetCategories().catch(() => []);
    set({ categories: list });
  },
  createCategory: async (name: string) => {
    const created = await api.createPresetCategory(name);
    set({ categories: [...get().categories, created].sort((a, b) =>
      a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    ) });
    return created;
  },
  renameCategory: async (id, name) => {
    const updated = await api.renamePresetCategory(id, name);
    set({
      categories: get().categories.map((c) => (c.id === id ? updated : c)),
    });
    return updated;
  },
  deleteCategory: async (id) => {
    await api.deletePresetCategory(id);
    set({ categories: get().categories.filter((c) => c.id !== id) });
    await Promise.all([get().refreshPresets(), get().refreshUserLuts()]);
  },
  setPresetCategory: async (presetId, categoryId) => {
    await api.setPresetCategory(presetId, categoryId);
    await get().refreshPresets();
  },
  setUserLutCategory: async (lutId, categoryId) => {
    await api.setUserLutCategory(lutId, categoryId);
    await get().refreshUserLuts();
  },
```

- [ ] **Step 8.4: 在应用启动钩子调用 `refreshCategories`**

`grep -n "refreshPresets\|refreshUserLuts" src/App.tsx src/main.tsx src/pages/EditorPage.tsx 2>/dev/null` 找到所有「启动时刷新预设/LUT」的位置，与之并列追加 `refreshCategories()` 调用，确保启动时分类列表有数据。

- [ ] **Step 8.5: `pnpm tsc --noEmit && pnpm lint`**

预期：通过。

- [ ] **Step 8.6: 提交**

```bash
git add src/store.ts src/App.tsx src/pages/EditorPage.tsx 2>/dev/null
git commit -m "feat(store): add categories slice with CRUD actions"
```

---

## Phase 4：前端组件目录化

### Task 8.5: 前置依赖 — 添加 shadcn/ui `context-menu` 组件

**Files:**
- Create: `src/components/ui/context-menu.tsx`

> 项目 `src/components/ui/` 目前只有 `dropdown-menu.tsx`，没有 `context-menu.tsx`。Task 12/13 都会用到，先补齐。`@radix-ui/react-context-menu` 是 shadcn/ui 的标准依赖。

- [ ] **Step 8.5.1: 检查依赖**

```bash
grep -E "@radix-ui/react-context-menu" package.json || pnpm add @radix-ui/react-context-menu
```

- [ ] **Step 8.5.2: 参考 `dropdown-menu.tsx` 的实现风格新建 `context-menu.tsx`**

按 shadcn/ui 官方模板（https://ui.shadcn.com/docs/components/context-menu）创建文件，导出
`ContextMenu / ContextMenuTrigger / ContextMenuContent / ContextMenuItem / ContextMenuSub /
ContextMenuSubTrigger / ContextMenuSubContent`。如对照 `dropdown-menu.tsx`，把 `DropdownMenu*`
替换为 `ContextMenu*`、把底层 import 从 `@radix-ui/react-dropdown-menu` 换成
`@radix-ui/react-context-menu` 即可（API 完全对应）。

- [ ] **Step 8.5.3: `pnpm tsc --noEmit && pnpm lint`**

预期：通过。

- [ ] **Step 8.5.4: 提交**

```bash
git add package.json pnpm-lock.yaml src/components/ui/context-menu.tsx
git commit -m "chore(ui): add shadcn context-menu primitive"
```

---

### Task 9: 把 `PresetList.tsx` 改为目录骨架（无功能变化）

**Files:**
- Create: `src/components/Editor/PresetList/index.tsx`
- Delete: `src/components/Editor/PresetList.tsx`

> 目的：先确保骨架可独立编译运行，再分步注入新功能。先把现有 `PresetList.tsx` 内容平移到 `PresetList/index.tsx`，删除旧文件，外部 import 路径无需调整（`@/components/Editor/PresetList` 在两种文件结构下都解析到 index）。

- [ ] **Step 9.1: 复制 `src/components/Editor/PresetList.tsx` 内容到 `src/components/Editor/PresetList/index.tsx`**

确保新文件顶部 `export function PresetList()` 与原签名一致，导入路径相对工作区不变。

- [ ] **Step 9.2: 删除原 `src/components/Editor/PresetList.tsx`**

```bash
git rm src/components/Editor/PresetList.tsx
```

- [ ] **Step 9.3: 跑 dev 启动确认渲染**

```bash
pnpm dev
```

打开应用，左侧预设面板应当与重构前完全一致。Ctrl+C 停止。

- [ ] **Step 9.4: 跑 `pnpm tsc --noEmit && pnpm lint`**

预期：通过。

- [ ] **Step 9.5: 提交**

```bash
git add -A src/components/Editor/PresetList
git commit -m "refactor(editor): convert PresetList file to directory"
```

---

### Task 10: 实现 `CategoryDialog`（含失败测试）

**Files:**
- Create: `src/components/Editor/PresetList/CategoryDialog.tsx`
- Create: `src/components/Editor/PresetList/__tests__/CategoryDialog.test.tsx`
- Modify: `src/i18n/zh.ts`、`src/i18n/en.ts`

- [ ] **Step 10.1: 在 i18n 加 key**

`src/i18n/zh.ts` 的 `editor.presetList` 子树（如不存在则创建）追加：

```ts
        newCategory: "新建分类",
        renameCategory: "重命名分类",
        categoryNamePlaceholder: "输入分类名称",
        categoryNameExists: "该分类名已存在",
        categoryNameEmpty: "请输入分类名称",
```

`src/i18n/en.ts` 同位置追加：

```ts
        newCategory: "New category",
        renameCategory: "Rename category",
        categoryNamePlaceholder: "Enter category name",
        categoryNameExists: "Category name already exists",
        categoryNameEmpty: "Please enter a category name",
```

- [ ] **Step 10.2: 写组件测试（先失败）**

新建 `src/components/Editor/PresetList/__tests__/CategoryDialog.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CategoryDialog } from "../CategoryDialog";
import { api } from "@/api";

vi.mock("@/api", () => ({
  api: {
    checkPresetCategoryNameExists: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock("@/store", () => {
  const createCategory = vi.fn().mockResolvedValue({
    id: 1,
    name: "合照",
    sort_order: 0,
    created_at: "",
  });
  const renameCategory = vi.fn().mockResolvedValue({
    id: 1,
    name: "合照精选",
    sort_order: 0,
    created_at: "",
  });
  return {
    useStore: (selector: (s: any) => any) =>
      selector({ createCategory, renameCategory }),
  };
});

describe("CategoryDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clamps input to 20 chars and shows counter", () => {
    render(<CategoryDialog mode="create" open onOpenChange={() => {}} />);
    const input = screen.getByPlaceholderText("输入分类名称") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "a".repeat(25) } });
    expect(input.value.length).toBe(20);
    expect(screen.getByText(/20\s*\/\s*20/)).toBeInTheDocument();
  });

  it("shows duplicate error and disables submit when name exists", async () => {
    (api.checkPresetCategoryNameExists as any).mockResolvedValueOnce(true);
    const onOpenChange = vi.fn();
    render(<CategoryDialog mode="create" open onOpenChange={onOpenChange} />);
    const input = screen.getByPlaceholderText("输入分类名称");
    fireEvent.change(input, { target: { value: "合照" } });
    await waitFor(() => {
      expect(screen.getByText("该分类名已存在")).toBeInTheDocument();
    });
    const submit = screen.getByRole("button", { name: /确定|OK/i });
    expect(submit).toBeDisabled();
  });

  it("calls onOpenChange(false) on successful create", async () => {
    const onOpenChange = vi.fn();
    render(<CategoryDialog mode="create" open onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByPlaceholderText("输入分类名称"), {
      target: { value: "合照" },
    });
    fireEvent.click(screen.getByRole("button", { name: /确定|OK/i }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
```

- [ ] **Step 10.3: 跑测试，确认失败**

```bash
pnpm test -- src/components/Editor/PresetList/__tests__/CategoryDialog.test.tsx --run
```

预期：FAIL（找不到 `CategoryDialog` 模块）。

- [ ] **Step 10.4: 实现 `CategoryDialog.tsx`**

新建 `src/components/Editor/PresetList/CategoryDialog.tsx`（控制在 150 行内）：

```tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { api } from "@/api";

const MAX_NAME_LEN = 20;

type Mode =
  | { mode: "create" }
  | { mode: "rename"; id: number; initialName: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Mode;

export function CategoryDialog(props: Props) {
  const { t } = useTranslation();
  const createCategory = useStore((s) => s.createCategory);
  const renameCategory = useStore((s) => s.renameCategory);

  const initial = props.mode === "rename" ? props.initialName : "";
  const [name, setName] = useState(initial);
  const [duplicate, setDuplicate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (props.open) {
      setName(initial);
      setDuplicate(false);
      setServerError(null);
    }
  }, [props.open, initial]);

  useEffect(() => {
    if (!name.trim()) {
      setDuplicate(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const excludeId = props.mode === "rename" ? props.id : null;
      const exists = await api
        .checkPresetCategoryNameExists(name.trim(), excludeId)
        .catch(() => false);
      setDuplicate(exists);
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [name, props]);

  const trimmed = name.trim();
  const canSubmit = !!trimmed && !duplicate && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError(null);
    try {
      if (props.mode === "create") {
        await createCategory(trimmed);
      } else {
        await renameCategory(props.id, trimmed);
      }
      props.onOpenChange(false);
    } catch (e) {
      setServerError(String(e ?? ""));
    } finally {
      setSubmitting(false);
    }
  }

  const title =
    props.mode === "create"
      ? t("editor.presetList.newCategory")
      : t("editor.presetList.renameCategory");

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Input
            autoFocus
            placeholder={t("editor.presetList.categoryNamePlaceholder")}
            value={name}
            maxLength={MAX_NAME_LEN}
            onChange={(e) => setName(e.target.value.slice(0, MAX_NAME_LEN))}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-zinc-500">
            {name.length}/{MAX_NAME_LEN}
          </span>
        </div>
        {duplicate && (
          <p className="text-xs text-red-500">
            {t("editor.presetList.categoryNameExists")}
          </p>
        )}
        {serverError && (
          <p className="text-xs text-red-500">{serverError}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {t("common.ok")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

> 若 `common.ok` / `common.cancel` 翻译键不存在，运行 `grep -rn 'common.ok\|common.cancel' src/i18n` 确认，并在缺失时按需补齐。

- [ ] **Step 10.5: 跑测试，确认通过**

```bash
pnpm test -- src/components/Editor/PresetList/__tests__/CategoryDialog.test.tsx --run
```

预期：3 个测试均 PASS。

- [ ] **Step 10.6: `pnpm lint`**

预期：通过。

- [ ] **Step 10.7: 提交**

```bash
git add src/components/Editor/PresetList/CategoryDialog.tsx src/components/Editor/PresetList/__tests__/CategoryDialog.test.tsx src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(editor): add CategoryDialog with name validation"
```

---

### Task 11: 实现 `ImportLutDialog`

**Files:**
- Create: `src/components/Editor/PresetList/ImportLutDialog.tsx`
- Modify: `src/i18n/zh.ts`、`src/i18n/en.ts`

- [ ] **Step 11.1: i18n 新增**

zh：
```ts
        importLutTitle: "导入 LUT",
        importLutSelectCategory: "分类",
        noCategory: "不分类",
        next: "下一步",
```

en：
```ts
        importLutTitle: "Import LUT",
        importLutSelectCategory: "Category",
        noCategory: "Uncategorized",
        next: "Next",
```

- [ ] **Step 11.2: 创建 `ImportLutDialog.tsx`**

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";

export type ImportLutSource = "files" | "dir";

type Props = {
  open: boolean;
  source: ImportLutSource;
  onOpenChange: (open: boolean) => void;
  onConfirm: (categoryId: number | null) => void;
};

export function ImportLutDialog({ open, source, onOpenChange, onConfirm }: Props) {
  const { t } = useTranslation();
  const categories = useStore((s) => s.categories);
  const [value, setValue] = useState<string>("__none__");

  const title =
    source === "files"
      ? t("editor.presetList.importLutTitle")
      : t("editor.presetList.importLutTitle");

  function handleConfirm() {
    const categoryId =
      value === "__none__" ? null : Number(value);
    onConfirm(categoryId);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-xs text-zinc-400">
            {t("editor.presetList.importLutSelectCategory")}
          </label>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">
                {t("editor.presetList.noCategory")}
              </SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleConfirm}>
            {t("editor.presetList.next")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 11.3: `pnpm tsc --noEmit && pnpm lint`**

预期：通过。

- [ ] **Step 11.4: 提交**

```bash
git add src/components/Editor/PresetList/ImportLutDialog.tsx src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(editor): add ImportLutDialog for picking category before import"
```

---

### Task 12: 实现 `PresetCard`

**Files:**
- Create: `src/components/Editor/PresetList/PresetCard.tsx`
- Modify: `src/i18n/zh.ts`、`src/i18n/en.ts`

- [ ] **Step 12.1: i18n 新增**

zh：
```ts
        moveToCategory: "移动到分类...",
        delete: "删除",
        confirmDeletePreset: "确定删除这个预设？",
        confirmDeleteLut: "确定删除这个 LUT？",
```

en：
```ts
        moveToCategory: "Move to category...",
        delete: "Delete",
        confirmDeletePreset: "Delete this preset?",
        confirmDeleteLut: "Delete this LUT?",
```

- [ ] **Step 12.2: 创建 `PresetCard.tsx`**

```tsx
import { Layers, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useStore } from "@/store";
import { api } from "@/api";
import { PASS_THROUGH_SIM, type FilterPreset, type UserLut } from "@/types";

export type PresetEntry =
  | { kind: "preset"; preset: FilterPreset }
  | { kind: "lut"; lut: UserLut };

type Props = {
  entry: PresetEntry;
  active: boolean;
  onApply: () => void;
};

export function PresetCard({ entry, active, onApply }: Props) {
  const { t } = useTranslation();
  const categories = useStore((s) => s.categories);
  const setPresetCategory = useStore((s) => s.setPresetCategory);
  const setUserLutCategory = useStore((s) => s.setUserLutCategory);
  const refreshPresets = useStore((s) => s.refreshPresets);
  const refreshUserLuts = useStore((s) => s.refreshUserLuts);

  const isPreset = entry.kind === "preset";
  const name = isPreset ? entry.preset.name : entry.lut.name;
  const Icon = isPreset ? SlidersHorizontal : Layers;

  async function handleMove(categoryId: number | null) {
    if (entry.kind === "preset") {
      await setPresetCategory(entry.preset.id, categoryId);
    } else {
      await setUserLutCategory(entry.lut.id, categoryId);
    }
  }

  async function handleDelete() {
    const confirmKey =
      entry.kind === "preset"
        ? "editor.presetList.confirmDeletePreset"
        : "editor.presetList.confirmDeleteLut";
    if (!window.confirm(t(confirmKey))) return;
    if (entry.kind === "preset") {
      await api.deletePreset(entry.preset.id);
      await refreshPresets();
    } else {
      await api.deleteUserLut(entry.lut.id);
      await refreshUserLuts();
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onApply}
          title={name}
          className={cn(
            "w-full flex items-center gap-2 text-left rounded-md border px-2 py-1.5 text-xs transition-colors",
            active
              ? "border-blue-500 bg-blue-500/10 text-zinc-100"
              : "border-zinc-800 hover:border-zinc-600 text-zinc-300",
          )}
        >
          <Icon size={14} className="flex-shrink-0" />
          <span className="truncate">{name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {t("editor.presetList.moveToCategory")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onClick={() => handleMove(null)}>
              {t("editor.presetList.noCategory")}
            </ContextMenuItem>
            {categories.map((c) => (
              <ContextMenuItem key={c.id} onClick={() => handleMove(c.id)}>
                {c.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={handleDelete}>
          {t("editor.presetList.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function applyEntry(
  entry: PresetEntry,
  setFilter: (patch: Partial<{ base_simulation: string; lut_file_path: string | null }>) => void,
  applyPreset: (p: FilterPreset) => void,
) {
  if (entry.kind === "preset") {
    applyPreset(entry.preset);
  } else {
    setFilter({ base_simulation: PASS_THROUGH_SIM, lut_file_path: entry.lut.file_path });
  }
}
```

> 注意：Task 8.5 已新建 `src/components/ui/context-menu.tsx`，本任务直接 import。

- [ ] **Step 12.3: `pnpm tsc --noEmit && pnpm lint`**

预期：通过。

- [ ] **Step 12.4: 提交**

```bash
git add src/components/Editor/PresetList/PresetCard.tsx src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(editor): add PresetCard with move-to-category context menu"
```

---

### Task 13: 实现 `PresetGroupedList` 与单元测试

**Files:**
- Create: `src/components/Editor/PresetList/PresetGroupedList.tsx`
- Create: `src/components/Editor/PresetList/__tests__/PresetGroupedList.test.tsx`
- Modify: `src/i18n/zh.ts`、`src/i18n/en.ts`

- [ ] **Step 13.1: i18n 新增**

zh：
```ts
        uncategorized: "未分类",
        emptyCategory: "该分类下暂无预设",
        confirmDeleteCategory: "删除分类后，分类下条目将回到「未分类」，确定删除吗？",
        rename: "重命名",
```

en：
```ts
        uncategorized: "Uncategorized",
        emptyCategory: "No presets in this category",
        confirmDeleteCategory: "After deleting, items will move to Uncategorized. Continue?",
        rename: "Rename",
```

- [ ] **Step 13.2: 写组件失败测试**

新建 `src/components/Editor/PresetList/__tests__/PresetGroupedList.test.tsx`：

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PresetGroupedList } from "../PresetGroupedList";
import type { FilterPreset, UserLut, PresetCategory } from "@/types";

vi.mock("@/store", () => ({
  useStore: (selector: (s: any) => any) =>
    selector({
      categories: [
        { id: 1, name: "合照", sort_order: 0, created_at: "" },
        { id: 2, name: "胶片", sort_order: 1, created_at: "" },
      ] as PresetCategory[],
      presets: [
        { id: 10, name: "我的P1", is_builtin: 0, category_id: 1, base_simulation: "Provia" },
        { id: 11, name: "我的P2", is_builtin: 0, category_id: null, base_simulation: "Velvia" },
        { id: 99, name: "Provia", is_builtin: 1, category_id: null, base_simulation: "Provia" },
      ] as unknown as FilterPreset[],
      userLuts: [
        { id: 50, name: "FilmLook", file_path: "/x.cube", category_id: 2, created_at: "" },
      ] as UserLut[],
      filter: { base_simulation: "Pass-Through", lut_file_path: null },
      applyPreset: vi.fn(),
      setFilter: vi.fn(),
      setPresetCategory: vi.fn(),
      setUserLutCategory: vi.fn(),
      refreshPresets: vi.fn(),
      refreshUserLuts: vi.fn(),
      renameCategory: vi.fn(),
      deleteCategory: vi.fn(),
    }),
}));

describe("PresetGroupedList", () => {
  it("groups custom presets and luts under categories with uncategorized first", () => {
    render(<PresetGroupedList search="" />);
    const headings = screen.getAllByTestId("category-header").map((el) => el.textContent ?? "");
    expect(headings[0]).toMatch(/未分类/);
    expect(headings[1]).toMatch(/合照/);
    expect(headings[2]).toMatch(/胶片/);
    expect(screen.getByText("我的P1")).toBeInTheDocument();
    expect(screen.getByText("我的P2")).toBeInTheDocument();
    expect(screen.getByText("FilmLook")).toBeInTheDocument();
    // 内置预设不出现在「我的」列表
    expect(screen.queryByText("Provia")).toBeNull();
  });

  it("filters by search keyword and hides empty groups", () => {
    render(<PresetGroupedList search="P1" />);
    expect(screen.getByText("我的P1")).toBeInTheDocument();
    expect(screen.queryByText("FilmLook")).toBeNull();
    const headings = screen.getAllByTestId("category-header").map((el) => el.textContent ?? "");
    expect(headings.some((h) => h.includes("胶片"))).toBe(false);
  });
});
```

- [ ] **Step 13.3: 跑测试，确认失败**

```bash
pnpm test -- src/components/Editor/PresetList/__tests__/PresetGroupedList.test.tsx --run
```

预期：FAIL（找不到模块）。

- [ ] **Step 13.4: 实现 `PresetGroupedList.tsx`**

```tsx
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useStore } from "@/store";
import { CategoryDialog } from "./CategoryDialog";
import { PresetCard, type PresetEntry, applyEntry } from "./PresetCard";

type Props = { search: string };

const UNCATEGORIZED_KEY = "__uncategorized__";

export function PresetGroupedList({ search }: Props) {
  const { t } = useTranslation();
  const categories = useStore((s) => s.categories);
  const presets = useStore((s) => s.presets);
  const userLuts = useStore((s) => s.userLuts);
  const filter = useStore((s) => s.filter);
  const applyPreset = useStore((s) => s.applyPreset);
  const setFilter = useStore((s) => s.setFilter);
  const renameCategory = useStore((s) => s.renameCategory);
  const deleteCategory = useStore((s) => s.deleteCategory);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renameTarget, setRenameTarget] = useState<{ id: number; name: string } | null>(null);

  const lower = search.trim().toLowerCase();

  const grouped = useMemo(() => {
    const buckets = new Map<string, PresetEntry[]>();
    buckets.set(UNCATEGORIZED_KEY, []);
    for (const c of categories) buckets.set(String(c.id), []);

    for (const p of presets) {
      if (p.is_builtin) continue;
      const key = p.category_id == null ? UNCATEGORIZED_KEY : String(p.category_id);
      if (!buckets.has(key)) buckets.set(UNCATEGORIZED_KEY, buckets.get(UNCATEGORIZED_KEY) ?? []);
      buckets.get(key === UNCATEGORIZED_KEY ? UNCATEGORIZED_KEY : key)!.push({ kind: "preset", preset: p });
    }
    for (const l of userLuts) {
      const key = l.category_id == null ? UNCATEGORIZED_KEY : String(l.category_id);
      if (!buckets.has(key)) buckets.set(UNCATEGORIZED_KEY, buckets.get(UNCATEGORIZED_KEY) ?? []);
      buckets.get(key === UNCATEGORIZED_KEY ? UNCATEGORIZED_KEY : key)!.push({ kind: "lut", lut: l });
    }

    function matches(e: PresetEntry): boolean {
      if (!lower) return true;
      const name = e.kind === "preset" ? e.preset.name : e.lut.name;
      return name.toLowerCase().includes(lower);
    }

    const order: { key: string; label: string }[] = [
      { key: UNCATEGORIZED_KEY, label: t("editor.presetList.uncategorized") },
      ...categories
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
        .map((c) => ({ key: String(c.id), label: c.name })),
    ];

    return order.map(({ key, label }) => {
      const items = (buckets.get(key) ?? []).filter(matches);
      return { key, label, items };
    });
  }, [presets, userLuts, categories, lower, t]);

  function toggle(key: string) {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  }

  function isActive(entry: PresetEntry): boolean {
    if (entry.kind === "preset") {
      return filter.base_simulation === entry.preset.base_simulation
        && (filter.lut_file_path ?? null) === (entry.preset.lut_file_path ?? null);
    }
    return filter.lut_file_path === entry.lut.file_path;
  }

  return (
    <div className="space-y-3">
      {grouped.map((group) => {
        if (lower && group.items.length === 0) return null;
        const open = !collapsed.has(group.key);
        const isUncategorized = group.key === UNCATEGORIZED_KEY;
        const categoryId = isUncategorized ? null : Number(group.key);
        const Header = (
          <button
            type="button"
            data-testid="category-header"
            onClick={() => toggle(group.key)}
            className="flex items-center gap-1 w-full text-left text-xs text-zinc-300 hover:text-zinc-100"
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="truncate">{group.label}</span>
            <span className="text-zinc-500 ml-1">({group.items.length})</span>
          </button>
        );
        return (
          <div key={group.key}>
            {isUncategorized ? (
              Header
            ) : (
              <ContextMenu>
                <ContextMenuTrigger asChild>{Header}</ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onClick={() =>
                      setRenameTarget({ id: categoryId!, name: group.label })
                    }
                  >
                    {t("editor.presetList.rename")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={async () => {
                      if (!window.confirm(t("editor.presetList.confirmDeleteCategory"))) return;
                      await deleteCategory(categoryId!);
                    }}
                  >
                    {t("editor.presetList.delete")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )}
            {open && (
              <div className="mt-1 space-y-1 pl-4">
                {group.items.length === 0 ? (
                  <p className="text-[11px] text-zinc-600">
                    {t("editor.presetList.emptyCategory")}
                  </p>
                ) : (
                  group.items.map((entry, idx) => (
                    <PresetCard
                      key={`${entry.kind}-${idx}-${entry.kind === "preset" ? entry.preset.id : entry.lut.id}`}
                      entry={entry}
                      active={isActive(entry)}
                      onApply={() =>
                        applyEntry(entry, (patch) => setFilter(patch as any), applyPreset)
                      }
                    />
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
      {renameTarget && (
        <CategoryDialog
          mode="rename"
          id={renameTarget.id}
          initialName={renameTarget.name}
          open={true}
          onOpenChange={(o) => {
            if (!o) setRenameTarget(null);
            void renameCategory;
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 13.5: 跑测试，确认通过**

```bash
pnpm test -- src/components/Editor/PresetList/__tests__/PresetGroupedList.test.tsx --run
```

预期：2 个测试均 PASS。

- [ ] **Step 13.6: `pnpm lint`**

预期：通过。

- [ ] **Step 13.7: 提交**

```bash
git add src/components/Editor/PresetList/PresetGroupedList.tsx src/components/Editor/PresetList/__tests__/PresetGroupedList.test.tsx src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(editor): add PresetGroupedList with uncategorized + categories"
```

---

### Task 14: 实现 `PresetListHeader`（搜索切换 + + 菜单）

**Files:**
- Create: `src/components/Editor/PresetList/PresetListHeader.tsx`
- Modify: `src/i18n/zh.ts`、`src/i18n/en.ts`

- [ ] **Step 14.1: i18n 新增**

zh：
```ts
        title: "预设",
        searchPlaceholder: "搜索",
        importPreset: "导入预设",
        importFiles: "导入文件",
        importDir: "导入文件夹",
```

en：
```ts
        title: "Presets",
        searchPlaceholder: "Search",
        importPreset: "Import preset",
        importFiles: "Import files",
        importDir: "Import folder",
```

- [ ] **Step 14.2: 创建 `PresetListHeader.tsx`**

```tsx
import { useState } from "react";
import { ArrowLeft, Plus, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useStore } from "@/store";
import { api } from "@/api";
import { CategoryDialog } from "./CategoryDialog";
import { ImportLutDialog, type ImportLutSource } from "./ImportLutDialog";

type Props = {
  showPlus: boolean;
  search: string;
  setSearch: (v: string) => void;
};

export function PresetListHeader({ showPlus, search, setSearch }: Props) {
  const { t } = useTranslation();
  const refreshUserLuts = useStore((s) => s.refreshUserLuts);

  const [searching, setSearching] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [importDialog, setImportDialog] = useState<null | ImportLutSource>(null);

  function exitSearch() {
    setSearching(false);
    setSearch("");
  }

  async function pickLuts(categoryId: number | null, source: ImportLutSource) {
    if (source === "files") {
      const selected = await openDialog({
        multiple: true,
        filters: [{ name: "Cube LUT", extensions: ["cube", "CUBE"] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;
      await api.importLuts(paths, categoryId);
    } else {
      const selected = await openDialog({ directory: true, multiple: false });
      if (!selected || typeof selected !== "string") return;
      await api.importLutsFromDir(selected, categoryId);
    }
    await refreshUserLuts();
  }

  return (
    <div className="flex items-center justify-between px-2 py-2 border-b border-zinc-800/60">
      {searching ? (
        <div className="flex items-center gap-1 flex-1">
          <button
            type="button"
            onClick={exitSearch}
            className="text-zinc-400 hover:text-zinc-100"
            aria-label="back"
          >
            <ArrowLeft size={14} />
          </button>
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("editor.presetList.searchPlaceholder")}
            className="h-7 text-xs"
            onKeyDown={(e) => {
              if (e.key === "Escape") exitSearch();
            }}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="text-zinc-400 hover:text-zinc-100"
              aria-label="clear"
            >
              <X size={14} />
            </button>
          )}
        </div>
      ) : (
        <>
          <h2 className="text-sm font-medium text-zinc-200">
            {t("editor.presetList.title")}
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSearching(true)}
              className="text-zinc-400 hover:text-zinc-100"
              aria-label="search"
            >
              <Search size={14} />
            </button>
            {showPlus && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="text-zinc-400 hover:text-zinc-100"
                    aria-label="add"
                  >
                    <Plus size={16} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      {t("editor.presetList.importPreset")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => setImportDialog("files")}>
                        {t("editor.presetList.importFiles")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setImportDialog("dir")}>
                        {t("editor.presetList.importDir")}
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                    {t("editor.presetList.newCategory")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </>
      )}
      <CategoryDialog mode="create" open={createOpen} onOpenChange={setCreateOpen} />
      {importDialog && (
        <ImportLutDialog
          open
          source={importDialog}
          onOpenChange={(o) => !o && setImportDialog(null)}
          onConfirm={(categoryId) => pickLuts(categoryId, importDialog)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 14.3: `pnpm tsc --noEmit && pnpm lint`**

预期：通过。

- [ ] **Step 14.4: 提交**

```bash
git add src/components/Editor/PresetList/PresetListHeader.tsx src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(editor): add PresetListHeader with search toggle and import menu"
```

---

### Task 15: 重写 `PresetList/index.tsx` 组装新布局

**Files:**
- Modify: `src/components/Editor/PresetList/index.tsx`

- [ ] **Step 15.1: 整体替换 `index.tsx`**

```tsx
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useStore } from "@/store";
import { cn } from "@/lib/utils";
import { PresetListHeader } from "./PresetListHeader";
import { PresetGroupedList } from "./PresetGroupedList";
import { PresetCard, type PresetEntry, applyEntry } from "./PresetCard";

export function PresetList() {
  const { t } = useTranslation();
  const presets = useStore((s) => s.presets);
  const filter = useStore((s) => s.filter);
  const applyPreset = useStore((s) => s.applyPreset);
  const setFilter = useStore((s) => s.setFilter);
  const refreshPresets = useStore((s) => s.refreshPresets);
  const refreshUserLuts = useStore((s) => s.refreshUserLuts);
  const refreshCategories = useStore((s) => s.refreshCategories);

  const [tab, setTab] = useState<"builtin" | "mine">("builtin");
  const [search, setSearch] = useState("");

  useEffect(() => {
    void refreshPresets();
    void refreshUserLuts();
    void refreshCategories();
  }, [refreshPresets, refreshUserLuts, refreshCategories]);

  const builtinFiltered = useMemo(() => {
    const q = search.toLowerCase();
    return presets.filter((p) => p.is_builtin && p.name.toLowerCase().includes(q));
  }, [presets, search]);

  return (
    <aside className="w-[220px] flex-shrink-0 flex flex-col bg-zinc-950 border-l border-zinc-800/60 overflow-hidden">
      <PresetListHeader showPlus={tab === "mine"} search={search} setSearch={setSearch} />
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "builtin" | "mine")}
        className="flex-1 flex flex-col overflow-hidden"
      >
        <div className="px-2 pt-2">
          <TabsList className="w-full grid grid-cols-2">
            <TabsTrigger value="builtin">{t("editor.presetList.builtin")}</TabsTrigger>
            <TabsTrigger value="mine">{t("editor.presetList.mine")}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="builtin" className="flex-1 overflow-y-auto px-2 mt-2 space-y-1">
          {builtinFiltered.map((p) => {
            const entry: PresetEntry = { kind: "preset", preset: p };
            const active = filter.base_simulation === p.base_simulation;
            return (
              <PresetCard
                key={p.id}
                entry={entry}
                active={active}
                onApply={() => applyEntry(entry, (patch) => setFilter(patch as any), applyPreset)}
              />
            );
          })}
        </TabsContent>
        <TabsContent value="mine" className="flex-1 overflow-y-auto px-2 mt-2">
          <PresetGroupedList search={search} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

// 防止 ChatGPT 误判 cn 未使用
void cn;
```

> 把末尾 `void cn;` 删掉，仅是占位提醒；如果 `cn` 真没用上就删掉 import。

- [ ] **Step 15.2: 启动应用手动验证**

```bash
pnpm dev
```

手测：
1. 「推荐」tab 仍能看到 13 个内置预设；
2. 「我的」tab 上方显示标题「预设」、搜索图标、+；
3. 点 + → 看到「导入预设 →」与「新建分类」；
4. 「新建分类」→ 弹框 → 输入「合照」→ 确定 → 列表中出现「合照」分组；
5. 点搜索图标 → 输入框出现 → 输入关键字过滤；
6. 「← 返回」回到默认。

观察后 Ctrl+C 停止。

- [ ] **Step 15.3: `pnpm lint && pnpm test --run`**

预期：通过。

- [ ] **Step 15.4: 提交**

```bash
git add src/components/Editor/PresetList/index.tsx
git commit -m "feat(editor): assemble new PresetList with header and grouped list"
```

---

## Phase 5：FilterPanel 改造

### Task 16: 移除 FilterPanel 的 LUT 下拉与导入入口

**Files:**
- Modify: `src/components/FilterPanel.tsx`

- [ ] **Step 16.1: 删除 LUT 相关代码块**

打开 [src/components/FilterPanel.tsx](src/components/FilterPanel.tsx)：

1. 删除 `LUT_PREFIX = "lut:"` 常量及其所有引用。
2. 删除 `selectedValue` 中针对 LUT 的分支与 `userLuts` 的 import / 调用。
3. 删除 `handleSimulationChange` 中处理 `LUT_PREFIX` 的分支。
4. 删除 `<SelectGroup>` 中渲染用户 LUT 的整段（`{userLuts.length > 0 && ...}`）。
5. 删除「导入 LUT」DropdownMenu 整段（`<DropdownMenu> ... </DropdownMenu>`）及 `importLuts` / `importLutsFromDir` 两个内部函数与 `importingLut` 状态。
6. 删除 `Files`、`FolderOpen`、`ChevronDown`（如仅此处用到）等已无引用的 lucide 图标 import。
7. 顶部 `import { open as openDialog } from "@tauri-apps/plugin-dialog";` 若已无引用则删除。

完成后保留：「胶片模拟」下拉只剩富士内置 + Pass-Through。

- [ ] **Step 16.2: 编译并跑 lint**

```bash
pnpm tsc --noEmit && pnpm lint
```

预期：通过。

- [ ] **Step 16.3: 启动 dev 检查**

```bash
pnpm dev
```

确认：
1. 右侧「胶片模拟」下拉中**没有**用户 LUT 列表；
2. 「调整」tab 顶部**没有**「导入 LUT」入口；
3. 应用 LUT：仍可在左侧「我的」点击 LUT 卡片，预览正常变化。

Ctrl+C 停止。

- [ ] **Step 16.4: 提交**

```bash
git add src/components/FilterPanel.tsx
git commit -m "refactor(filter-panel): remove LUT entries, defer to PresetList"
```

---

### Task 17: 「保存预设」弹框增加分类字段

**Files:**
- Modify: `src/components/FilterPanel.tsx`
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`

- [ ] **Step 17.1: i18n 新增**

zh `filterPanel`：
```ts
        savePresetCategory: "分类",
```

en `filterPanel`：
```ts
        savePresetCategory: "Category",
```

- [ ] **Step 17.2: 在 FilterPanel 顶部 import `Select` 子组件、`useStore` 拿 `categories`**

```tsx
import { useStore } from "@/store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
```

（如已 import，跳过）

- [ ] **Step 17.3: 增加 state**

在 `saveName` state 旁：

```tsx
const categories = useStore((s) => s.categories);
const [saveCategoryId, setSaveCategoryId] = useState<string>("__none__");
```

`saveAsPreset` 在 `await api.savePreset({...})` 入参中增加：

```tsx
      category_id: saveCategoryId === "__none__" ? null : Number(saveCategoryId),
```

成功后：

```tsx
    setSaveCategoryId("__none__");
```

- [ ] **Step 17.4: 在保存预设弹框加分类下拉**

找到 `<DialogContent>` 内 `Input` 之后追加：

```tsx
<div className="mt-3 space-y-1">
  <label className="text-xs text-zinc-400">
    {t("filterPanel.savePresetCategory")}
  </label>
  <Select value={saveCategoryId} onValueChange={setSaveCategoryId}>
    <SelectTrigger><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="__none__">{t("editor.presetList.noCategory")}</SelectItem>
      {categories.map((c) => (
        <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
      ))}
    </SelectContent>
  </Select>
</div>
```

- [ ] **Step 17.5: `pnpm tsc --noEmit && pnpm lint && pnpm test --run`**

预期：通过。

- [ ] **Step 17.6: 启动 dev 手测**

调一组参数 → 调整 tab 内点「保存为预设」→ 弹框含分类下拉 → 选「合照」→ 确定 → 「我的」中「合照」组下出现新预设。

- [ ] **Step 17.7: 提交**

```bash
git add src/components/FilterPanel.tsx src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(filter-panel): save preset dialog supports category"
```

---

## Phase 6：收尾验收

### Task 18: 全量验证 + 端到端 smoke

**Files:**
- 无文件改动

- [ ] **Step 18.1: 后端全量验证**

```bash
cd src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

预期：全部通过。

- [ ] **Step 18.2: 前端全量验证**

```bash
pnpm tsc --noEmit && pnpm lint && pnpm test --run
```

预期：全部通过。

- [ ] **Step 18.3: 端到端手动 smoke（按 spec §9.3）**

启动 `pnpm dev`，按以下顺序：

1. 新建分类「合照」→「我的」中出现 `合照 (0)` 分组；
2. 调一组参数 → 「保存为预设」选「合照」→ 列表「合照」组下出现新预设；
3. 点 +→ 导入预设 → 导入文件 → 选「合照」→ 选 `.cube` → 「合照」组下出现 LUT 卡片；
4. 点搜索图标 → 输入预设名 → 跨分类过滤；← 返回 → 全列表恢复；
5. 「合照」分组标题右键 → 重命名为「合照精选」；
6. 「合照精选」分组标题右键 → 删除 → 内容回到「未分类」；
7. 右侧「胶片模拟」下拉确认无 LUT、无导入入口。

任一项不通过 → 修问题 → 重新跑 18.1 / 18.2 / 18.3。

- [ ] **Step 18.4: 文件行数复核**

```bash
wc -l src-tauri/src/db/preset_categories.rs src-tauri/src/db/presets.rs src-tauri/src/db/user_luts.rs src-tauri/src/ipc.rs src/components/Editor/PresetList/*.tsx src/components/FilterPanel.tsx src/store.ts
```

预期：全部 < 500 行。任何超出 → 拆模块。

- [ ] **Step 18.5: 提交（如有最后修复）**

```bash
git status
# 如有改动
git add -A
git commit -m "chore: e2e smoke fixes"
```

---

## 任务汇总

| Task | 说明 | 是否独立可提交 |
| --- | --- | --- |
| 1 | 数据库 schema + 迁移 | ✅ |
| 2 | preset_categories CRUD | ✅ |
| 3 | presets 加 category_id + set_category | ✅ |
| 4 | user_luts 加 category_id + set_category | ✅ |
| 5 | 7 条新 IPC 命令 | ✅ |
| 6 | 改造 import_luts/import_luts_from_dir | ✅ |
| 7 | types.ts + api.ts | ✅ |
| 8 | store.ts | ✅ |
| 8.5 | shadcn context-menu 基础组件 | ✅ |
| 9 | PresetList 目录化（无功能） | ✅ |
| 10 | CategoryDialog | ✅ |
| 11 | ImportLutDialog | ✅ |
| 12 | PresetCard | ✅ |
| 13 | PresetGroupedList | ✅ |
| 14 | PresetListHeader | ✅ |
| 15 | PresetList/index 装配 | ✅ |
| 16 | FilterPanel 移除 LUT | ✅ |
| 17 | 保存预设弹框加分类 | ✅ |
| 18 | 全量验收 | ✅ |

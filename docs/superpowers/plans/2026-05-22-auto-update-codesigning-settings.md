# 自动更新 + 代码签名 + 设置页 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入 Tauri Updater + macOS 代码签名 + 公证流程，并整合现有"主题/语言/清缓存"功能到一个完整设置页中。

**Architecture:** 四子系统拼装：①SQLite 通用 KV 设置表 + 设置页（先做）→ ②Tauri Updater 插件 + 客户端 UI → ③版本号自动同步脚本 → ④阿里云 OSS 上传脚本。设置页用 Radix Dialog + Tab 路由复用现有依赖，更新插件用官方 `tauri-plugin-updater` 配合 minisign 签名，分发走 `static.ai520.wiki/fujisim/` 路径。

**Tech Stack:** Tauri 2 / Rust / sqlx / React 18 / TypeScript / @radix-ui / @tauri-apps/plugin-updater / ali-oss / minisign / Apple Developer ID

---

## 文件结构总览

### 新增

```
src-tauri/src/db/app_settings.rs               KV 表 CRUD（~100 行）
scripts/bump-version.mjs                       版本号同步（~70 行）
scripts/publish-update.mjs                     OSS 上传 + latest.json 生成（~130 行）

src/hooks/use-settings.ts                      设置 hook（~80 行）
src/hooks/use-updater.ts                       updater hook（~120 行）

src/components/UpdaterBootstrap.tsx            启动检查触发器（~30 行）
src/components/UpdateToast.tsx                 状态机 Toast（~140 行）
src/components/Settings/index.ts               导出
src/components/Settings/SettingsDialog.tsx     容器 + Tab 路由（~120 行）
src/components/Settings/tabs/GeneralTab.tsx    主题 + 语言（~80 行）
src/components/Settings/tabs/CacheTab.tsx      迁移自 ClearCacheDialog（~80 行）
src/components/Settings/tabs/UpdateTab.tsx     更新设置 + 检查（~150 行）
src/components/Settings/tabs/AboutTab.tsx      版本 + 链接（~80 行）

docs/superpowers/specs/2026-05-22-auto-update-future-work-todo.md  已创建
```

### 修改

```
src-tauri/Cargo.toml                          + tauri-plugin-updater
                                              + [package].version = "1.0.1"
src-tauri/src/db/mod.rs                       + app_settings 表 migration
                                              + pub mod app_settings
src-tauri/src/lib.rs                          + .plugin(tauri_plugin_updater::Builder::new().build())
                                              + 4 个 IPC handler
src-tauri/src/ipc.rs                          + get_setting/set_setting/delete_setting/get_all_settings
src-tauri/capabilities/default.json           + "updater:default"
src-tauri/tauri.conf.json                     + plugins.updater 段（pubkey + endpoint）

src/api.ts                                    + 4 个 settings 方法
src/store.ts                                  - theme/toggleTheme/language/toggleLanguage 字段
src/App.tsx                                   + <UpdaterBootstrap />
src/components/Sidebar.tsx                    重写 settings 按钮：dropdown → 直接打开 SettingsDialog
                                              - import ClearCacheDialog（迁走了）
src/i18n/zh.ts                                + settings.* 段
src/i18n/en.ts                                + settings.* 段

package.json                                  + scripts: version:sync, prebuild:*, publish:update
                                              + devDeps: ali-oss
.env.production.local                         + ALIYUN_OSS_* 变量
```

### 删除

```
src/components/ClearCacheDialog.tsx           内容迁入 CacheTab.tsx
```

---

## 阶段 1：SQLite 设置表 + 后端 IPC

### Task 1: 新增 app_settings 表 migration

**Files:**
- Modify: `src-tauri/src/db/mod.rs:45-280`（在 `run_migrations` 函数末尾追加 SQL 段，并新增 `pub mod app_settings;`）

- [ ] **Step 1: 修改 mod.rs，在模块声明区追加 app_settings**

在 `src-tauri/src/db/mod.rs:7-13`（现有 `pub mod` 列表）末尾追加：

```rust
pub mod app_settings;
```

- [ ] **Step 2: 在 run_migrations 中新增建表 SQL**

定位 `run_migrations` 函数（约第 45 行），找到现有 `CREATE TABLE IF NOT EXISTS user_fonts` 之后的最后一段建表 SQL，在该函数 `Ok(())` 返回之前追加：

```rust
sqlx::query(
    r#"
    CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );
    "#,
)
.execute(pool)
.await?;
```

- [ ] **Step 3: 编译验证**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: 编译通过（可能有 `app_settings` 模块未找到的警告，下个 task 解决）

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/mod.rs
git commit -m "feat(db): add app_settings KV table migration"
```

---

### Task 2: 实现 db/app_settings.rs CRUD

**Files:**
- Create: `src-tauri/src/db/app_settings.rs`

- [ ] **Step 1: 创建 app_settings.rs**

```rust
//! 应用设置 KV 存储。
//!
//! 用于持久化用户偏好（主题、语言、更新检查策略等）。
//! key 命名约定参见 `docs/superpowers/specs/2026-05-22-auto-update-codesigning-settings-design.md` 第 6.3 节。

use crate::error::Result;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// 取单个设置值。返回 `None` 表示该 key 从未被设置。
pub async fn get(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM app_settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(v,)| v))
}

/// 写入或更新设置值。`updated_at` 自动维护为当前 unix 时间戳。
pub async fn set(pool: &SqlitePool, key: &str, value: &str) -> Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    sqlx::query(
        r#"
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        "#,
    )
    .bind(key)
    .bind(value)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// 删除某个设置项。删除不存在的 key 不视为错误。
pub async fn delete(pool: &SqlitePool, key: &str) -> Result<()> {
    sqlx::query("DELETE FROM app_settings WHERE key = ?1")
        .bind(key)
        .execute(pool)
        .await?;
    Ok(())
}

/// 一次性读取所有设置项，返回 key->value HashMap。前端启动时调用，避免 N 次 IPC。
pub async fn get_all(pool: &SqlitePool) -> Result<HashMap<String, String>> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM app_settings")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().collect())
}
```

- [ ] **Step 2: cargo check 验证**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: 编译通过，0 警告 0 错误

- [ ] **Step 3: 写一个最小集成测试**

在 `src-tauri/src/db/app_settings.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("memory pool");
        sqlx::query(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
        )
        .execute(&pool)
        .await
        .expect("create table");
        pool
    }

    #[tokio::test]
    async fn get_returns_none_for_missing_key() {
        let pool = test_pool().await;
        assert_eq!(get(&pool, "missing").await.expect("get"), None);
    }

    #[tokio::test]
    async fn set_then_get_roundtrip() {
        let pool = test_pool().await;
        set(&pool, "ui.theme", "dark").await.expect("set");
        assert_eq!(
            get(&pool, "ui.theme").await.expect("get"),
            Some("dark".to_string())
        );
    }

    #[tokio::test]
    async fn set_overwrites_existing() {
        let pool = test_pool().await;
        set(&pool, "ui.theme", "light").await.expect("set 1");
        set(&pool, "ui.theme", "dark").await.expect("set 2");
        assert_eq!(
            get(&pool, "ui.theme").await.expect("get"),
            Some("dark".to_string())
        );
    }

    #[tokio::test]
    async fn delete_removes_key() {
        let pool = test_pool().await;
        set(&pool, "ui.theme", "dark").await.expect("set");
        delete(&pool, "ui.theme").await.expect("delete");
        assert_eq!(get(&pool, "ui.theme").await.expect("get"), None);
    }

    #[tokio::test]
    async fn get_all_returns_empty_when_no_settings() {
        let pool = test_pool().await;
        assert!(get_all(&pool).await.expect("get_all").is_empty());
    }

    #[tokio::test]
    async fn get_all_returns_all_settings() {
        let pool = test_pool().await;
        set(&pool, "ui.theme", "dark").await.expect("set 1");
        set(&pool, "ui.language", "en").await.expect("set 2");
        let all = get_all(&pool).await.expect("get_all");
        assert_eq!(all.len(), 2);
        assert_eq!(all.get("ui.theme"), Some(&"dark".to_string()));
        assert_eq!(all.get("ui.language"), Some(&"en".to_string()));
    }
}
```

- [ ] **Step 4: 运行测试**

Run: `cd src-tauri && cargo test --lib db::app_settings 2>&1 | tail -20`
Expected: `test result: ok. 6 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/app_settings.rs
git commit -m "feat(db): implement app_settings KV CRUD with tests"
```

---

### Task 3: 添加 IPC 命令

**Files:**
- Modify: `src-tauri/src/ipc.rs`（追加 4 个 command）
- Modify: `src-tauri/src/lib.rs`（注册 4 个 handler）

- [ ] **Step 1: 在 ipc.rs 末尾追加 4 个命令**

定位 `src-tauri/src/ipc.rs` 文件末尾，追加：

```rust
// ===== 应用设置 =====

#[tauri::command]
pub async fn get_setting(
    state: tauri::State<'_, crate::state::AppState>,
    key: String,
) -> Result<Option<String>, String> {
    crate::db::app_settings::get(&state.pool, &key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_setting(
    state: tauri::State<'_, crate::state::AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    crate::db::app_settings::set(&state.pool, &key, &value)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_setting(
    state: tauri::State<'_, crate::state::AppState>,
    key: String,
) -> Result<(), String> {
    crate::db::app_settings::delete(&state.pool, &key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_settings(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    crate::db::app_settings::get_all(&state.pool)
        .await
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: 在 lib.rs 注册 4 个 handler**

定位 `src-tauri/src/lib.rs` 的 `tauri::generate_handler![` 块，在合适分组（例如最后一个分组）后追加：

```rust
            // ===== 应用设置 =====
            ipc::get_setting,
            ipc::set_setting,
            ipc::delete_setting,
            ipc::get_all_settings,
```

- [ ] **Step 3: cargo check 验证**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: 编译通过

- [ ] **Step 4: cargo clippy 验证**

Run: `cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings 2>&1 | tail -20`
Expected: 无 warning 无 error

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): expose app_settings CRUD commands"
```

---

## 阶段 2：前端 Settings hook + Dialog 骨架

### Task 4: api.ts 增加 settings 方法

**Files:**
- Modify: `src/api.ts`（追加 4 个方法）

- [ ] **Step 1: 在 api 对象末尾追加方法**

定位 `src/api.ts` 中 `export const api = {` 块的最后一个方法之后（保留闭合 `};` 之前），追加：

```typescript
  // ===== 应用设置 =====
  /** 取单个设置值，未设置返回 null */
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  /** 写入或更新设置值。value 必须是字符串，复杂类型由调用方 JSON.stringify */
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  /** 删除某项设置 */
  deleteSetting: (key: string) => invoke<void>("delete_setting", { key }),
  /** 一次性获取所有设置，启动时调用 */
  getAllSettings: () => invoke<Record<string, string>>("get_all_settings"),
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `cd /Users/ry2019/private/FujiSim && pnpm tsc --noEmit 2>&1 | tail -10`
Expected: 0 错误

- [ ] **Step 3: Commit**

```bash
git add src/api.ts
git commit -m "feat(api): expose settings IPC bindings"
```

---

### Task 5: 创建 useSettings hook

**Files:**
- Create: `src/hooks/use-settings.ts`

- [ ] **Step 1: 创建 hook 文件**

```typescript
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api";

export type Theme = "light" | "dark";
export type Language = "zh" | "en";

export interface Settings {
  theme: Theme;
  language: Language;
  updateAutoCheck: boolean;
  updateConfirmInstall: boolean;
  updateSkippedVersions: string[];
  updateLastCheck: string;
}

const DEFAULTS: Settings = {
  theme: "light",
  language: "zh",
  updateAutoCheck: true,
  updateConfirmInstall: true,
  updateSkippedVersions: [],
  updateLastCheck: "",
};

const KEYS = {
  theme: "ui.theme",
  language: "ui.language",
  updateAutoCheck: "update.auto_check",
  updateConfirmInstall: "update.confirm_install",
  updateSkippedVersions: "update.skipped_versions",
  updateLastCheck: "update.last_check",
} as const;

function parseSettings(kv: Record<string, string>): Settings {
  const get = <K extends keyof Settings>(key: keyof typeof KEYS, fallback: Settings[K]): Settings[K] => {
    const raw = kv[KEYS[key]];
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as Settings[K];
    } catch {
      return fallback;
    }
  };
  return {
    theme: get("theme", DEFAULTS.theme),
    language: get("language", DEFAULTS.language),
    updateAutoCheck: get("updateAutoCheck", DEFAULTS.updateAutoCheck),
    updateConfirmInstall: get("updateConfirmInstall", DEFAULTS.updateConfirmInstall),
    updateSkippedVersions: get("updateSkippedVersions", DEFAULTS.updateSkippedVersions),
    updateLastCheck: get("updateLastCheck", DEFAULTS.updateLastCheck),
  };
}

export function useSettings() {
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    api
      .getAllSettings()
      .then((kv) => {
        if (cancelled) return;
        setSettings(parseSettings(kv));
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(
    async <K extends keyof Settings>(key: K, value: Settings[K]) => {
      await api.setSetting(KEYS[key], JSON.stringify(value));
      setSettings((s) => ({ ...s, [key]: value }));
    },
    []
  );

  return { settings, update, loaded };
}
```

- [ ] **Step 2: TypeScript 编译验证**

Run: `pnpm tsc --noEmit 2>&1 | tail -5`
Expected: 0 错误

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-settings.ts
git commit -m "feat(hooks): add useSettings for SQLite-backed preferences"
```

---

### Task 6: i18n 增加 settings.* 段

**Files:**
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

- [ ] **Step 1: 在 zh.ts 末尾闭合大括号前追加 settings 段**

```typescript
  settings: {
    title: "设置",
    tabs: {
      general: "通用",
      cache: "缓存",
      update: "更新",
      about: "关于",
    },
    general: {
      theme: "主题",
      themeLight: "浅色",
      themeDark: "深色",
      language: "语言",
      chinese: "中文",
      english: "English",
    },
    update: {
      currentVersion: "当前版本",
      lastCheck: "最后检查",
      lastCheckNever: "从未检查",
      checkNow: "立即检查更新",
      autoCheck: "启动时自动检查更新",
      confirmInstall: "下载更新前询问",
      skippedVersions: "已跳过的版本",
      cancelSkip: "取消跳过",
      noSkipped: "暂无跳过的版本",
      states: {
        idle: "未检查",
        checking: "检查中...",
        available: "发现新版本 {{version}}",
        downloading: "下载中 {{progress}}%",
        ready: "下载完成，请重启应用",
        upToDate: "已是最新版本",
        error: "检查失败：{{message}}",
      },
      actions: {
        download: "下载并安装",
        install: "立即重启应用",
        skip: "跳过此版本",
        later: "稍后",
      },
    },
    about: {
      version: "版本",
      website: "官网",
      websiteUrl: "https://static.ai520.wiki",
      license: "许可证",
      licenseValue: "MIT",
    },
  },
```

- [ ] **Step 2: 同步 en.ts**

```typescript
  settings: {
    title: "Settings",
    tabs: {
      general: "General",
      cache: "Cache",
      update: "Updates",
      about: "About",
    },
    general: {
      theme: "Theme",
      themeLight: "Light",
      themeDark: "Dark",
      language: "Language",
      chinese: "中文",
      english: "English",
    },
    update: {
      currentVersion: "Current version",
      lastCheck: "Last checked",
      lastCheckNever: "Never",
      checkNow: "Check for updates",
      autoCheck: "Check for updates on startup",
      confirmInstall: "Ask before installing updates",
      skippedVersions: "Skipped versions",
      cancelSkip: "Unskip",
      noSkipped: "No skipped versions",
      states: {
        idle: "Idle",
        checking: "Checking...",
        available: "New version {{version}} available",
        downloading: "Downloading {{progress}}%",
        ready: "Download complete, please restart",
        upToDate: "Up to date",
        error: "Check failed: {{message}}",
      },
      actions: {
        download: "Download and install",
        install: "Restart now",
        skip: "Skip this version",
        later: "Later",
      },
    },
    about: {
      version: "Version",
      website: "Website",
      websiteUrl: "https://static.ai520.wiki",
      license: "License",
      licenseValue: "MIT",
    },
  },
```

- [ ] **Step 3: 验证 TypeScript**

Run: `pnpm tsc --noEmit 2>&1 | tail -5`
Expected: 0 错误

- [ ] **Step 4: Commit**

```bash
git add src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(i18n): add settings translations for zh and en"
```

---

### Task 7: 创建 SettingsDialog 容器（Tab 路由 + 占位 tabs）

**Files:**
- Create: `src/components/Settings/SettingsDialog.tsx`
- Create: `src/components/Settings/index.ts`

- [ ] **Step 1: 创建 index.ts**

```typescript
export { SettingsDialog } from "./SettingsDialog";
```

- [ ] **Step 2: 创建 SettingsDialog.tsx**

```typescript
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings as SettingsIcon, Database, RefreshCw, Info } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type TabKey = "general" | "cache" | "update" | "about";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState<TabKey>("general");

  const tabs: Array<{ key: TabKey; icon: typeof SettingsIcon; label: string }> = [
    { key: "general", icon: SettingsIcon, label: t("settings.tabs.general") },
    { key: "cache", icon: Database, label: t("settings.tabs.cache") },
    { key: "update", icon: RefreshCw, label: t("settings.tabs.update") },
    { key: "about", icon: Info, label: t("settings.tabs.about") },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        <DialogTitle className="sr-only">{t("settings.title")}</DialogTitle>
        <div className="flex h-[520px]">
          <nav className="w-44 border-r border-zinc-800/60 bg-zinc-950/40 py-4 px-2 flex flex-col gap-1">
            {tabs.map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                onClick={() => setActive(key)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors text-left",
                  active === key
                    ? "bg-zinc-800/80 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
                )}
              >
                <Icon size={14} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="flex-1 p-6 overflow-y-auto">
            {active === "general" && <PlaceholderTab name="General" />}
            {active === "cache" && <PlaceholderTab name="Cache" />}
            {active === "update" && <PlaceholderTab name="Update" />}
            {active === "about" && <PlaceholderTab name="About" />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PlaceholderTab({ name }: { name: string }) {
  return <div className="text-sm text-zinc-400">{name} tab — coming up</div>;
}
```

- [ ] **Step 3: TypeScript 验证**

Run: `pnpm tsc --noEmit 2>&1 | tail -5`
Expected: 0 错误

- [ ] **Step 4: Commit**

```bash
git add src/components/Settings/SettingsDialog.tsx src/components/Settings/index.ts
git commit -m "feat(settings): add SettingsDialog shell with tab routing"
```

---

### Task 8: Sidebar 接入 SettingsDialog

**Files:**
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: 改写齿轮按钮区域**

定位 `src/components/Sidebar.tsx:142-162`（DropdownMenu 块）。整体替换为直接打开 SettingsDialog 的按钮。

先在 import 区追加：

```typescript
import { SettingsDialog } from "@/components/Settings";
```

修改 import 区中已有的 lucide-react 行，删除不再需要的 `Sun, Moon, Eraser, Globe`，保留 `Search, RotateCcw, Settings`：

```typescript
import { Search, RotateCcw, Settings } from "lucide-react";
```

删除已有的 DropdownMenu 相关 import（行 12-16）：

```typescript
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
```

- [ ] **Step 2: 替换组件 state 与 渲染**

在组件内部找到现有的 `const [clearCacheOpen, setClearCacheOpen] = useState(false);`，**整体替换**为：

```typescript
const [settingsOpen, setSettingsOpen] = useState(false);
```

并删除现有的 `theme/toggleTheme/toggleLanguage` 三行（行 25-27）：

```typescript
const theme = useStore((s) => s.theme);
const toggleTheme = useStore((s) => s.toggleTheme);
const toggleLanguage = useStore((s) => s.toggleLanguage);
```

- [ ] **Step 3: 替换渲染区**

把行 142-162 的整个 DropdownMenu 块替换为：

```typescript
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 flex-shrink-0"
          title={t("sidebar.settings")}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={14} />
        </Button>
```

把行 165 的 `<ClearCacheDialog open={clearCacheOpen} onOpenChange={setClearCacheOpen} />` 替换为：

```typescript
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
```

并删除文件顶部的 `import { ClearCacheDialog } ...` 行。

- [ ] **Step 4: TypeScript 验证 + 跑一次 dev**

Run: `pnpm tsc --noEmit 2>&1 | tail -5`
Expected: 0 错误

Run: `pnpm dev`（手动验证）
Expected: 点击右上角齿轮 → SettingsDialog 弹出，左侧 4 个 Tab 可切换

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(sidebar): replace dropdown with full settings dialog"
```

---

## 阶段 3：迁移现有功能到设置页

### Task 9: 实现 GeneralTab（主题 + 语言）

**Files:**
- Create: `src/components/Settings/tabs/GeneralTab.tsx`
- Modify: `src/store.ts`（删除 theme/language 字段）
- Modify: `src/components/Settings/SettingsDialog.tsx`（连接 GeneralTab）

- [ ] **Step 1: 创建 GeneralTab.tsx**

```typescript
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { useSettings, type Theme, type Language } from "@/hooks/use-settings";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function GeneralTab() {
  const { t } = useTranslation();
  const { settings, update, loaded } = useSettings();

  useEffect(() => {
    if (!loaded) return;
    if (settings.theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [settings.theme, loaded]);

  useEffect(() => {
    if (!loaded) return;
    if (i18n.language !== settings.language) {
      i18n.changeLanguage(settings.language);
    }
  }, [settings.language, loaded]);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <Label>{t("settings.general.theme")}</Label>
        <Select
          value={settings.theme}
          onValueChange={(v) => update("theme", v as Theme)}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">{t("settings.general.themeLight")}</SelectItem>
            <SelectItem value="dark">{t("settings.general.themeDark")}</SelectItem>
          </SelectContent>
        </Select>
      </section>
      <section className="space-y-2">
        <Label>{t("settings.general.language")}</Label>
        <Select
          value={settings.language}
          onValueChange={(v) => update("language", v as Language)}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh">{t("settings.general.chinese")}</SelectItem>
            <SelectItem value="en">{t("settings.general.english")}</SelectItem>
          </SelectContent>
        </Select>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: 引入 GeneralTab**

修改 `src/components/Settings/SettingsDialog.tsx`，import 区追加：

```typescript
import { GeneralTab } from "./tabs/GeneralTab";
```

把 `{active === "general" && <PlaceholderTab name="General" />}` 替换为：

```typescript
{active === "general" && <GeneralTab />}
```

- [ ] **Step 3: 删除 store.ts 中的 theme/language 字段**

打开 `src/store.ts`，定位类型 `AppState`（约第 67-71 行），删除 4 行：

```typescript
theme: "light" | "dark";
toggleTheme: () => void;
language: "zh" | "en";
toggleLanguage: () => void;
```

定位 `create` 调用（约第 173-191 行），删除：

```typescript
theme: (localStorage.getItem("fujisim-theme") as "light" | "dark") || "light",
toggleTheme: () => {
  const newTheme = get().theme === "light" ? "dark" : "light";
  localStorage.setItem("fujisim-theme", newTheme);
  if (newTheme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
  set({ theme: newTheme });
},
language: (localStorage.getItem("fujisim-language") as "zh" | "en") || "zh",
toggleLanguage: () => {
  const newLang = get().language === "zh" ? "en" : "zh";
  localStorage.setItem("fujisim-language", newLang);
  set({ language: newLang });
  import("@/i18n").then(({ default: i18n }) => i18n.changeLanguage(newLang));
},
```

- [ ] **Step 4: 处理首次启动主题闪烁**

在 `src/main.tsx` 主入口或 `src/App.tsx` useEffect 顶部增加从 SQLite 异步读取主题的兜底：先打开 `src/App.tsx`，在最顶部 useEffect 之前追加：

```typescript
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
```

- [ ] **Step 5: TypeScript 验证**

Run: `pnpm tsc --noEmit 2>&1 | tail -10`
Expected: 0 错误（store 字段移除后任何对 `theme/toggleTheme` 的引用都会编译失败，应该已在 Sidebar 中清理）

- [ ] **Step 6: 手动验证**

Run: `pnpm dev`
Expected:
- 打开设置 → 通用 → 切换主题 → 立即生效
- 切换语言 → 整个 UI 文案立即切换
- 重启 App → 设置保持

- [ ] **Step 7: Commit**

```bash
git add src/components/Settings/tabs/GeneralTab.tsx \
        src/components/Settings/SettingsDialog.tsx \
        src/store.ts \
        src/App.tsx
git commit -m "feat(settings): migrate theme and language to GeneralTab"
```

---

### Task 10: 实现 CacheTab（迁移 ClearCacheDialog 内容）

**Files:**
- Create: `src/components/Settings/tabs/CacheTab.tsx`
- Modify: `src/components/Settings/SettingsDialog.tsx`
- Delete: `src/components/ClearCacheDialog.tsx`

- [ ] **Step 1: 创建 CacheTab.tsx**

```typescript
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export function CacheTab() {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function handleClear() {
    setClearing(true);
    try {
      await api.clearAllData();
      useStore.setState({
        assets: [],
        presets: [],
        userLuts: [],
        userFonts: [],
        exportTasks: new Map(),
        taskDetails: new Map(),
        dismissedTaskIds: new Set(),
        progress: null,
        watermarkPresets: [],
      });
      setConfirmOpen(false);
      await useStore.getState().refreshAssets();
      await useStore.getState().refreshFacets();
      await useStore.getState().refreshPresets();
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        {t("clearCache.desc1")}
        <strong className="text-zinc-200">{t("clearCache.descHighlight")}</strong>
        {t("clearCache.desc2")}
      </p>
      <ul className="text-sm text-zinc-400 list-disc list-inside space-y-1">
        <li>{t("clearCache.item1")}</li>
        <li>{t("clearCache.item2")}</li>
        <li>{t("clearCache.item3")}</li>
        <li>{t("clearCache.item4")}</li>
        <li>{t("clearCache.item5")}</li>
      </ul>
      <p className="text-xs text-amber-400">{t("clearCache.notice")}</p>
      <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
        {t("clearCache.confirmClear")}
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogTitle>{t("clearCache.title")}</DialogTitle>
          <DialogDescription>{t("clearCache.desc1")}</DialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={clearing}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={handleClear} disabled={clearing}>
              {clearing ? t("clearCache.clearing") : t("clearCache.confirmClear")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: 接入 SettingsDialog**

修改 `src/components/Settings/SettingsDialog.tsx`：

```typescript
import { CacheTab } from "./tabs/CacheTab";
```

替换：

```typescript
{active === "cache" && <CacheTab />}
```

- [ ] **Step 3: 删除原 ClearCacheDialog**

```bash
rm src/components/ClearCacheDialog.tsx
```

- [ ] **Step 4: TypeScript 验证**

Run: `pnpm tsc --noEmit 2>&1 | tail -5`
Expected: 0 错误（Sidebar 应该已经在 Task 8 时移除了 ClearCacheDialog 的 import）

- [ ] **Step 5: 手动验证**

Run: `pnpm dev`
Expected: 设置 → 缓存 → 清除按钮可弹出确认 dialog 并执行清除

- [ ] **Step 6: Commit**

```bash
git add src/components/Settings/tabs/CacheTab.tsx \
        src/components/Settings/SettingsDialog.tsx
git rm src/components/ClearCacheDialog.tsx
git commit -m "feat(settings): migrate ClearCacheDialog into CacheTab"
```

---

### Task 11: 实现 AboutTab

**Files:**
- Create: `src/components/Settings/tabs/AboutTab.tsx`
- Modify: `src/components/Settings/SettingsDialog.tsx`

- [ ] **Step 1: 创建 AboutTab.tsx**

```typescript
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { open as openShell } from "@tauri-apps/plugin-shell";
import { Button } from "@/components/ui/button";

export function AboutTab() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion("unknown"));
  }, []);

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-zinc-800/60 flex items-center justify-center">
          <img src="/icon.png" alt="FujiSim" className="w-12 h-12" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">FujiSim</h2>
          <p className="text-sm text-zinc-400">
            {t("settings.about.version")} {version}
          </p>
        </div>
      </header>
      <dl className="space-y-3 text-sm">
        <div className="flex justify-between border-b border-zinc-800/60 pb-2">
          <dt className="text-zinc-400">{t("settings.about.website")}</dt>
          <dd>
            <Button
              variant="link"
              className="h-auto p-0 text-zinc-200"
              onClick={() => openShell(t("settings.about.websiteUrl"))}
            >
              {t("settings.about.websiteUrl")}
            </Button>
          </dd>
        </div>
        <div className="flex justify-between border-b border-zinc-800/60 pb-2">
          <dt className="text-zinc-400">{t("settings.about.license")}</dt>
          <dd className="text-zinc-200">{t("settings.about.licenseValue")}</dd>
        </div>
      </dl>
    </div>
  );
}
```

- [ ] **Step 2: 接入 SettingsDialog**

```typescript
import { AboutTab } from "./tabs/AboutTab";
// ...
{active === "about" && <AboutTab />}
```

- [ ] **Step 3: TypeScript 验证**

Run: `pnpm tsc --noEmit 2>&1 | tail -5`
Expected: 0 错误

- [ ] **Step 4: 手动验证**

Run: `pnpm dev`
Expected: 设置 → 关于 → 显示版本号 1.0.1，点击官网链接在系统浏览器打开 https://static.ai520.wiki

- [ ] **Step 5: Commit**

```bash
git add src/components/Settings/tabs/AboutTab.tsx \
        src/components/Settings/SettingsDialog.tsx
git commit -m "feat(settings): add AboutTab with version and website link"
```

---

## 阶段 4：Updater 接入（Rust 端）

### Task 12: 添加 tauri-plugin-updater 依赖

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: 在 Cargo.toml [dependencies] 段追加**

```toml
tauri-plugin-updater = "2"
```

并在 `[package]` 段补上 version 字段（在 `edition = "2021"` 之前追加）：

```toml
version = "1.0.1"
```

- [ ] **Step 2: 在 lib.rs 注册插件**

定位 `src-tauri/src/lib.rs` 的 `tauri::Builder::default()` 后的链式调用，在已有 `.plugin(tauri_plugin_shell::init())` 之后追加：

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

- [ ] **Step 3: 修改 capabilities/default.json，permissions 数组追加**

```json
"updater:default"
```

- [ ] **Step 4: 修改 tauri.conf.json，bundle 段后添加 plugins 段**

读取 `~/.tauri/fujisim.key.pub` 内容（一长串 Base64 字符串），把它填入 pubkey。在文件 `bundle` 段闭合的 `}` 之后、整体闭合 `}` 之前添加：

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://static.ai520.wiki/fujisim/latest.json"
    ],
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ0MjE1OTE4QzE1QTA2NUEKUldSYUJsckJHRmtoUk9TZ05MbU1RQzBvMmFPQjJtbEUxWnhYWXhsVkREZS9NdEdmcTBSdkY3Z2YK",
    "windows": { "installMode": "passive" }
  }
}
```

- [ ] **Step 5: cargo check 验证**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: 编译通过（首次会拉取依赖，可能需要几分钟）

- [ ] **Step 6: cargo clippy 验证**

Run: `cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings 2>&1 | tail -20`
Expected: 0 warning 0 error

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock \
        src-tauri/src/lib.rs \
        src-tauri/capabilities/default.json \
        src-tauri/tauri.conf.json
git commit -m "feat(updater): integrate tauri-plugin-updater with minisign pubkey"
```

---

## 阶段 5：Updater 前端 UI

### Task 13: 安装 @tauri-apps/plugin-updater 前端 SDK

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装依赖**

Run: `pnpm add @tauri-apps/plugin-updater @tauri-apps/plugin-process`
Expected: 添加成功，pnpm-lock.yaml 更新

- [ ] **Step 2: TypeScript 验证**

Run: `pnpm tsc --noEmit 2>&1 | tail -5`
Expected: 0 错误

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat(updater): add tauri updater + process JS SDK"
```

---

### Task 14: 创建 useUpdater hook

**Files:**
- Create: `src/hooks/use-updater.ts`

- [ ] **Step 1: 创建 hook 文件**

```typescript
import { useCallback, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api } from "@/api";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "up-to-date" }
  | { kind: "error"; message: string };

const SKIPPED_KEY = "update.skipped_versions";
const LAST_CHECK_KEY = "update.last_check";

export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);

  const checkForUpdates = useCallback(async (silent = false) => {
    setState({ kind: "checking" });
    try {
      await api.setSetting(LAST_CHECK_KEY, JSON.stringify(new Date().toISOString()));
      const update = await check();
      if (!update) {
        setState({ kind: "up-to-date" });
        return;
      }

      if (silent) {
        const skippedRaw = await api.getSetting(SKIPPED_KEY);
        const skipped: string[] = skippedRaw ? JSON.parse(skippedRaw) : [];
        if (skipped.includes(update.version)) {
          setState({ kind: "idle" });
          return;
        }
      }

      setPendingUpdate(update);
      setState({
        kind: "available",
        version: update.version,
        notes: update.body ?? "",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({ kind: "error", message });
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (!pendingUpdate) return;
    setState({ kind: "downloading", progress: 0 });
    try {
      let downloaded = 0;
      let total = 0;
      await pendingUpdate.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (total > 0) {
              setState({
                kind: "downloading",
                progress: Math.min(99, Math.round((downloaded / total) * 100)),
              });
            }
            break;
          case "Finished":
            setState({ kind: "ready" });
            break;
        }
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({ kind: "error", message });
    }
  }, [pendingUpdate]);

  const restart = useCallback(async () => {
    await relaunch();
  }, []);

  const skipVersion = useCallback(async (version: string) => {
    const raw = await api.getSetting(SKIPPED_KEY);
    const skipped: string[] = raw ? JSON.parse(raw) : [];
    if (!skipped.includes(version)) {
      skipped.push(version);
      await api.setSetting(SKIPPED_KEY, JSON.stringify(skipped));
    }
    setState({ kind: "idle" });
  }, []);

  const cancelSkip = useCallback(async (version: string) => {
    const raw = await api.getSetting(SKIPPED_KEY);
    const skipped: string[] = raw ? JSON.parse(raw) : [];
    const next = skipped.filter((v) => v !== version);
    await api.setSetting(SKIPPED_KEY, JSON.stringify(next));
  }, []);

  const dismiss = useCallback(() => {
    setState({ kind: "idle" });
  }, []);

  return {
    state,
    checkForUpdates,
    downloadAndInstall,
    restart,
    skipVersion,
    cancelSkip,
    dismiss,
  };
}
```

- [ ] **Step 2: TypeScript 验证**

Run: `pnpm tsc --noEmit 2>&1 | tail -5`
Expected: 0 错误

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-updater.ts
git commit -m "feat(updater): add useUpdater hook with state machine"
```

---

### Task 15: 创建 UpdateToast 组件

**Files:**
- Create: `src/components/UpdateToast.tsx`

- [ ] **Step 1: 创建组件**

```typescript
import { useTranslation } from "react-i18next";
import {
  Toast,
  ToastAction,
  ToastDescription,
  ToastTitle,
} from "@/components/ui/toast";
import type { UpdateState } from "@/hooks/use-updater";

interface UpdateToastProps {
  state: UpdateState;
  onDownload: () => void;
  onRestart: () => void;
  onSkip: () => void;
  onDismiss: () => void;
  silent: boolean;
}

export function UpdateToast({
  state,
  onDownload,
  onRestart,
  onSkip,
  onDismiss,
  silent,
}: UpdateToastProps) {
  const { t } = useTranslation();

  const visible =
    state.kind === "available" ||
    state.kind === "downloading" ||
    state.kind === "ready" ||
    (!silent && state.kind === "error");

  if (!visible) return null;

  return (
    <Toast open onOpenChange={(o) => !o && onDismiss()}>
      {state.kind === "available" && (
        <>
          <ToastTitle>
            {t("settings.update.states.available", { version: state.version })}
          </ToastTitle>
          {state.notes && (
            <ToastDescription className="text-xs text-zinc-400">
              {state.notes}
            </ToastDescription>
          )}
          <div className="flex gap-2 mt-2">
            <ToastAction altText={t("settings.update.actions.download")} onClick={onDownload}>
              {t("settings.update.actions.download")}
            </ToastAction>
            <ToastAction altText={t("settings.update.actions.skip")} onClick={onSkip}>
              {t("settings.update.actions.skip")}
            </ToastAction>
          </div>
        </>
      )}

      {state.kind === "downloading" && (
        <>
          <ToastTitle>
            {t("settings.update.states.downloading", { progress: state.progress })}
          </ToastTitle>
          <div className="mt-2 h-1 w-full bg-zinc-800 rounded">
            <div
              className="h-full bg-zinc-200 rounded transition-all"
              style={{ width: `${state.progress}%` }}
            />
          </div>
        </>
      )}

      {state.kind === "ready" && (
        <>
          <ToastTitle>{t("settings.update.states.ready")}</ToastTitle>
          <div className="flex gap-2 mt-2">
            <ToastAction altText={t("settings.update.actions.install")} onClick={onRestart}>
              {t("settings.update.actions.install")}
            </ToastAction>
          </div>
        </>
      )}

      {state.kind === "error" && (
        <ToastTitle className="text-red-400">
          {t("settings.update.states.error", { message: state.message })}
        </ToastTitle>
      )}
    </Toast>
  );
}
```

- [ ] **Step 2: TypeScript 验证**

Run: `pnpm tsc --noEmit 2>&1 | tail -5`
Expected: 0 错误

- [ ] **Step 3: Commit**

```bash
git add src/components/UpdateToast.tsx
git commit -m "feat(updater): add UpdateToast UI driven by state machine"
```

---

### Task 16: 创建 UpdaterBootstrap 组件

**Files:**
- Create: `src/components/UpdaterBootstrap.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: 创建 UpdaterBootstrap**

```typescript
import { useEffect } from "react";
import { useUpdater } from "@/hooks/use-updater";
import { UpdateToast } from "@/components/UpdateToast";

export function UpdaterBootstrap() {
  const updater = useUpdater();

  useEffect(() => {
    const t = setTimeout(() => {
      updater.checkForUpdates(true);
    }, 3000);
    return () => clearTimeout(t);
  }, []);

  return (
    <UpdateToast
      state={updater.state}
      onDownload={updater.downloadAndInstall}
      onRestart={updater.restart}
      onSkip={() => {
        if (updater.state.kind === "available") {
          updater.skipVersion(updater.state.version);
        }
      }}
      onDismiss={updater.dismiss}
      silent={true}
    />
  );
}
```

- [ ] **Step 2: 在 App.tsx 挂载**

打开 `src/App.tsx`，import 区追加：

```typescript
import { UpdaterBootstrap } from "@/components/UpdaterBootstrap";
```

在 `App` 组件 return 区找到 `<Toaster />`，在它附近（同级）追加：

```typescript
<UpdaterBootstrap />
```

- [ ] **Step 3: TypeScript 验证**

Run: `pnpm tsc --noEmit 2>&1 | tail -5`
Expected: 0 错误

- [ ] **Step 4: 跑 dev**

Run: `pnpm dev`
Expected: App 启动后 3 秒触发 `check()`。由于此时 OSS 上还没 latest.json，**会显示 error toast 或进入 idle**。这是预期的，等 OSS 部署后会正常。

控制台应能看到 updater 调用，但不会崩溃。

- [ ] **Step 5: Commit**

```bash
git add src/components/UpdaterBootstrap.tsx src/App.tsx
git commit -m "feat(updater): bootstrap auto-check 3s after app start"
```

---

### Task 17: 实现 UpdateTab（设置页"更新"标签）

**Files:**
- Create: `src/components/Settings/tabs/UpdateTab.tsx`
- Modify: `src/components/Settings/SettingsDialog.tsx`

- [ ] **Step 1: 创建 UpdateTab.tsx**

```typescript
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/use-settings";
import { useUpdater } from "@/hooks/use-updater";

export function UpdateTab() {
  const { t } = useTranslation();
  const { settings, update, loaded } = useSettings();
  const updater = useUpdater();
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(""));
  }, []);

  const lastCheckLabel =
    settings.updateLastCheck === ""
      ? t("settings.update.lastCheckNever")
      : new Date(settings.updateLastCheck).toLocaleString();

  function renderActionButton() {
    switch (updater.state.kind) {
      case "checking":
        return (
          <Button disabled>{t("settings.update.states.checking")}</Button>
        );
      case "available":
        return (
          <Button onClick={updater.downloadAndInstall}>
            {t("settings.update.actions.download")}
          </Button>
        );
      case "downloading":
        return (
          <Button disabled>
            {t("settings.update.states.downloading", { progress: updater.state.progress })}
          </Button>
        );
      case "ready":
        return (
          <Button onClick={updater.restart}>
            {t("settings.update.actions.install")}
          </Button>
        );
      default:
        return (
          <Button onClick={() => updater.checkForUpdates(false)}>
            {t("settings.update.checkNow")}
          </Button>
        );
    }
  }

  if (!loaded) {
    return <div className="text-sm text-zinc-500">…</div>;
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex justify-between items-center">
          <span className="text-sm text-zinc-400">{t("settings.update.currentVersion")}</span>
          <span className="text-sm text-zinc-200">{version || "?"}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-zinc-400">{t("settings.update.lastCheck")}</span>
          <span className="text-sm text-zinc-200">{lastCheckLabel}</span>
        </div>
        <div className="pt-2">{renderActionButton()}</div>
        {updater.state.kind === "up-to-date" && (
          <p className="text-xs text-emerald-400">{t("settings.update.states.upToDate")}</p>
        )}
        {updater.state.kind === "error" && (
          <p className="text-xs text-red-400">
            {t("settings.update.states.error", { message: updater.state.message })}
          </p>
        )}
      </section>

      <section className="space-y-3 border-t border-zinc-800/60 pt-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="auto-check">{t("settings.update.autoCheck")}</Label>
          <Switch
            id="auto-check"
            checked={settings.updateAutoCheck}
            onCheckedChange={(v) => update("updateAutoCheck", v)}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="confirm-install">{t("settings.update.confirmInstall")}</Label>
          <Switch
            id="confirm-install"
            checked={settings.updateConfirmInstall}
            onCheckedChange={(v) => update("updateConfirmInstall", v)}
          />
        </div>
      </section>

      <section className="space-y-2 border-t border-zinc-800/60 pt-4">
        <Label>{t("settings.update.skippedVersions")}</Label>
        {settings.updateSkippedVersions.length === 0 ? (
          <p className="text-xs text-zinc-500">{t("settings.update.noSkipped")}</p>
        ) : (
          <ul className="space-y-1">
            {settings.updateSkippedVersions.map((v) => (
              <li key={v} className="flex items-center justify-between text-sm">
                <span className="text-zinc-300">{v}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    updater.cancelSkip(v);
                    update(
                      "updateSkippedVersions",
                      settings.updateSkippedVersions.filter((x) => x !== v)
                    );
                  }}
                >
                  {t("settings.update.cancelSkip")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: 检查 ui/switch 组件是否存在**

Run: `ls /Users/ry2019/private/FujiSim/src/components/ui/switch.tsx 2>/dev/null && echo EXISTS || echo MISSING`

如果输出 `MISSING`，新建 `src/components/ui/switch.tsx`：

```typescript
import * as React from "react";
import { cn } from "@/lib/utils";

export interface SwitchProps extends React.InputHTMLAttributes<HTMLInputElement> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, checked, onCheckedChange, ...props }, ref) => (
    <label className={cn("relative inline-flex h-5 w-9 cursor-pointer", className)}>
      <input
        type="checkbox"
        ref={ref}
        checked={checked}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        className="peer sr-only"
        {...props}
      />
      <span className="absolute inset-0 rounded-full bg-zinc-700 peer-checked:bg-emerald-500 transition-colors" />
      <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
    </label>
  )
);
Switch.displayName = "Switch";
```

- [ ] **Step 3: 接入 SettingsDialog**

```typescript
import { UpdateTab } from "./tabs/UpdateTab";
// ...
{active === "update" && <UpdateTab />}
```

- [ ] **Step 4: TypeScript 验证**

Run: `pnpm tsc --noEmit 2>&1 | tail -5`
Expected: 0 错误

- [ ] **Step 5: 手动验证**

Run: `pnpm dev`
Expected:
- 设置 → 更新 → 看到当前版本 1.0.1
- 自动检查 / 询问安装 两个 switch 切换后立即持久化（重开 dialog 状态保留）
- 点"立即检查"按钮（OSS 没数据时会进入 error/up-to-date）

- [ ] **Step 6: Commit**

```bash
git add src/components/Settings/tabs/UpdateTab.tsx \
        src/components/Settings/SettingsDialog.tsx \
        src/components/ui/switch.tsx
git commit -m "feat(settings): add UpdateTab with check button and preferences"
```

---

## 阶段 6：版本管理脚本

### Task 18: 创建 bump-version.mjs

**Files:**
- Create: `scripts/bump-version.mjs`
- Modify: `package.json`

- [ ] **Step 1: 创建 scripts 目录与 bump-version.mjs**

```bash
mkdir -p /Users/ry2019/private/FujiSim/scripts
```

写入 `scripts/bump-version.mjs`：

```javascript
#!/usr/bin/env node
// 把 package.json 的 version 同步到 src-tauri/tauri.conf.json 和 src-tauri/Cargo.toml。
// 在每次 `pnpm build:*` 之前由 prebuild 钩子自动调用。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function syncTauriConf(version) {
  const file = path.join(ROOT, "src-tauri/tauri.conf.json");
  const conf = await readJson(file);
  if (conf.version === version) return false;
  conf.version = version;
  await writeFile(file, JSON.stringify(conf, null, 2) + "\n", "utf8");
  return true;
}

async function syncCargoToml(version) {
  const file = path.join(ROOT, "src-tauri/Cargo.toml");
  const content = await readFile(file, "utf8");
  const re = /^(version\s*=\s*)"[^"]*"/m;
  if (!re.test(content)) {
    throw new Error("src-tauri/Cargo.toml 的 [package] 段缺少 version 字段");
  }
  const next = content.replace(re, `$1"${version}"`);
  if (next === content) return false;
  await writeFile(file, next, "utf8");
  return true;
}

async function main() {
  const pkg = await readJson(path.join(ROOT, "package.json"));
  const version = pkg.version;
  if (!version) throw new Error("package.json 缺少 version 字段");

  const tauriChanged = await syncTauriConf(version);
  const cargoChanged = await syncCargoToml(version);

  console.log(
    `[version:sync] package.json=${version}, tauri.conf.json=${tauriChanged ? "updated" : "unchanged"}, Cargo.toml=${cargoChanged ? "updated" : "unchanged"}`
  );
}

main().catch((e) => {
  console.error(`[version:sync] failed: ${e.message}`);
  process.exit(1);
});
```

- [ ] **Step 2: 修改 package.json scripts**

定位 `package.json` 的 `"scripts"` 段，在结尾追加（保持现有 scripts 不动）：

```json
"version:sync": "node scripts/bump-version.mjs",
"prebuild:mac": "pnpm version:sync",
"prebuild:mac-arm": "pnpm version:sync",
"prebuild:mac-x64": "pnpm version:sync",
"prebuild:win": "pnpm version:sync"
```

注意：你需要保证 JSON 合法（前一行加逗号，最后一项不加）。

- [ ] **Step 3: 跑一次 version:sync 验证**

Run: `cd /Users/ry2019/private/FujiSim && pnpm version:sync`
Expected: 输出 `[version:sync] package.json=1.0.1, tauri.conf.json=unchanged, Cargo.toml=updated`（因为 Cargo.toml 在 Task 12 已加了 1.0.1，这里会显示 unchanged 或 updated 取决于实际情况）

验证 Cargo.toml：

Run: `grep "^version" /Users/ry2019/private/FujiSim/src-tauri/Cargo.toml`
Expected: `version = "1.0.1"`

- [ ] **Step 4: Commit**

```bash
git add scripts/bump-version.mjs package.json
git commit -m "feat(scripts): auto-sync version from package.json before build"
```

---

## 阶段 7：OSS 上传脚本

### Task 19: 创建 publish-update.mjs

**Files:**
- Create: `scripts/publish-update.mjs`
- Modify: `package.json`
- Modify: `.env.production.local`

- [ ] **Step 1: 安装 ali-oss 依赖**

Run: `pnpm add -D ali-oss`
Expected: 安装成功

- [ ] **Step 2: 在 .env.production.local 追加 OSS 配置**

打开 [.env.production.local](.env.production.local)，在文件末尾追加：

```bash
# ============================================================
# 4) 阿里云 OSS（更新分发）
# ============================================================
ALIYUN_OSS_ACCESS_KEY_ID=""
ALIYUN_OSS_ACCESS_KEY_SECRET=""
ALIYUN_OSS_BUCKET="fujisim-updates"
ALIYUN_OSS_REGION="oss-cn-shenzhen"
ALIYUN_OSS_DOMAIN="static.ai520.wiki"
ALIYUN_OSS_PATH_PREFIX="fujisim"
```

- [ ] **Step 3: 创建 scripts/publish-update.mjs**

```javascript
#!/usr/bin/env node
// 收集打包产物 + 生成 latest.json + 上传阿里云 OSS。
// 前置：环境变量需通过 `set -a; source .env.production.local; set +a` 加载。

import OSS from "ali-oss";
import { readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const REQUIRED_ENV = [
  "ALIYUN_OSS_ACCESS_KEY_ID",
  "ALIYUN_OSS_ACCESS_KEY_SECRET",
  "ALIYUN_OSS_BUCKET",
  "ALIYUN_OSS_REGION",
  "ALIYUN_OSS_DOMAIN",
];

function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing env vars: ${missing.join(", ")}. Did you 'source .env.production.local'?`
    );
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function bundleDir(target) {
  return path.join(ROOT, "src-tauri/target", target, "release/bundle/macos");
}

async function findArtifacts(version) {
  const candidates = [
    "universal-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
  ];
  const found = {};
  for (const target of candidates) {
    const dir = bundleDir(target);
    if (!existsSync(dir)) continue;

    const tarGz = path.join(dir, `FujiSim_${version}_${suffixFor(target)}.app.tar.gz`);
    const sig = `${tarGz}.sig`;
    const dmg = path.join(ROOT, "src-tauri/target", target, "release/bundle/dmg",
                          `FujiSim_${version}_${suffixFor(target)}.dmg`);
    if (existsSync(tarGz) && existsSync(sig)) {
      found[target] = { tarGz, sig, dmg: existsSync(dmg) ? dmg : null };
    }
  }
  return found;
}

function suffixFor(target) {
  if (target.includes("universal")) return "universal";
  if (target.includes("aarch64")) return "aarch64";
  if (target.includes("x86_64")) return "x64";
  return target;
}

function platformKey(target) {
  if (target.includes("aarch64") || target.includes("universal")) {
    return "darwin-aarch64";
  }
  if (target.includes("x86_64")) return "darwin-x86_64";
  return null;
}

function urlFor(remoteKey) {
  return `https://${process.env.ALIYUN_OSS_DOMAIN}/${remoteKey}`;
}

async function main() {
  checkEnv();
  const pkg = await readJson(path.join(ROOT, "package.json"));
  const version = pkg.version;
  console.log(`[publish] version = ${version}`);

  const artifacts = await findArtifacts(version);
  if (Object.keys(artifacts).length === 0) {
    throw new Error("没有找到任何打包产物。先跑 pnpm build:mac");
  }

  const client = new OSS({
    region: process.env.ALIYUN_OSS_REGION,
    accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
    bucket: process.env.ALIYUN_OSS_BUCKET,
  });

  const prefix = process.env.ALIYUN_OSS_PATH_PREFIX || "fujisim";
  const platforms = {};

  for (const [target, files] of Object.entries(artifacts)) {
    const pkey = platformKey(target);
    if (!pkey) continue;

    const remoteTarGz = `${prefix}/releases/${version}/${path.basename(files.tarGz)}`;
    const remoteSig = `${prefix}/releases/${version}/${path.basename(files.sig)}`;

    console.log(`[publish] uploading ${remoteTarGz}`);
    await client.put(remoteTarGz, files.tarGz, {
      headers: { "Cache-Control": "public, max-age=2592000" },
    });

    console.log(`[publish] uploading ${remoteSig}`);
    await client.put(remoteSig, files.sig, {
      headers: { "Cache-Control": "public, max-age=2592000" },
    });

    if (files.dmg) {
      const remoteDmg = `${prefix}/releases/${version}/${path.basename(files.dmg)}`;
      console.log(`[publish] uploading ${remoteDmg}`);
      await client.put(remoteDmg, files.dmg, {
        headers: { "Cache-Control": "public, max-age=2592000" },
      });
    }

    const signature = await readFile(files.sig, "utf8");
    platforms[pkey] = {
      signature: signature.trim(),
      url: urlFor(remoteTarGz),
    };

    if (target.includes("universal")) {
      platforms["darwin-x86_64"] = platforms[pkey];
    }
  }

  const latest = {
    version,
    notes: pkg.description || "",
    pub_date: new Date().toISOString(),
    platforms,
  };

  const latestPath = path.join(ROOT, "dist-updates/latest.json");
  await writeFile(latestPath, JSON.stringify(latest, null, 2), "utf8").catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(latestPath), { recursive: true });
    await writeFile(latestPath, JSON.stringify(latest, null, 2), "utf8");
  });

  const remoteLatest = `${prefix}/latest.json`;
  console.log(`[publish] uploading ${remoteLatest}`);
  await client.put(remoteLatest, latestPath, {
    headers: { "Cache-Control": "no-cache, max-age=0" },
  });

  console.log(`[publish] done. latest.json -> ${urlFor(remoteLatest)}`);
}

main().catch((e) => {
  console.error(`[publish] failed: ${e.message}`);
  process.exit(1);
});
```

- [ ] **Step 4: 修改 package.json，scripts 段追加**

```json
"publish:update": "node scripts/publish-update.mjs"
```

- [ ] **Step 5: TypeScript / 语法验证（脚本是 mjs，无 ts 编译，跑 dry-run 校验语法）**

Run: `node --check scripts/publish-update.mjs && echo OK`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add scripts/publish-update.mjs package.json pnpm-lock.yaml .env.production.local
git commit -m "feat(scripts): add OSS publish script for updater distribution"
```

> 注意：commit 包含 .env.production.local 的修改。检查文件是否被 git 忽略（`.gitignore` 含 `*.local`）。如果被忽略，git add 这一行无操作，**这是正确行为**——env 文件不应进 git。

---

## 阶段 8：端到端验证

### Task 20: 本地签名打包验证

**Files:** （无修改，仅验证）

- [ ] **Step 1: 加载本地证书**

Run: `cd /Users/ry2019/private/FujiSim && set -a && source .env.local && set +a && echo "$APPLE_SIGNING_IDENTITY"`
Expected: 输出 `Apple Development: 2787716172@qq.com (W4T9X727L6)`

- [ ] **Step 2: 跑一次 macOS arm 打包**

Run: `pnpm build:mac-arm 2>&1 | tail -30`
Expected:
- prebuild:mac-arm 自动跑了 version:sync
- 编译成功，产物在 `src-tauri/target/aarch64-apple-darwin/release/bundle/`
- 终端能看到 `signing app` 相关日志

- [ ] **Step 3: 验证签名**

Run: `codesign -dv --verbose=4 src-tauri/target/aarch64-apple-darwin/release/bundle/macos/FujiSim.app 2>&1`
Expected:
- `Authority=Apple Development: ...`
- `TeamIdentifier=W4T9X727L6`
- 不报错

- [ ] **Step 4: 验证 .app.tar.gz 和 .sig 已生成**

Run: `ls src-tauri/target/aarch64-apple-darwin/release/bundle/macos/`
Expected: 至少看到 `FujiSim.app`、`FujiSim_1.0.1_aarch64.app.tar.gz`、`FujiSim_1.0.1_aarch64.app.tar.gz.sig`

- [ ] **Step 5: 启动产物，确认 App 能跑 + 设置页正常**

Run: `open src-tauri/target/aarch64-apple-darwin/release/bundle/macos/FujiSim.app`
Expected:
- App 启动
- 点击右上角齿轮 → 设置 dialog 弹出
- 通用 / 缓存 / 更新 / 关于 四 tab 切换正常
- 主题 / 语言 / 清缓存功能正常
- 启动 3 秒后 updater 触发，OSS 没数据时会显示 up-to-date 或 error（预期）

如有问题，回到对应阶段排查。

- [ ] **Step 6: 不做 commit（本步骤无文件改动）**

---

### Task 21: 完整发版流程演练（dry-run）

**Files:** （无修改，仅验证流程）

- [ ] **Step 1: 准备 OSS bucket（手动操作，记录步骤）**

> 这一步**不能自动化**，需要在阿里云控制台完成。手册：

1. 登录 https://oss.console.aliyun.com → 创建 bucket
   - 名称：`fujisim-updates`
   - region：`华南1（深圳）`
   - 读写权限：`私有`（用 access key 上传）
   - 服务端加密：默认即可
2. 进入 bucket → 域名管理 → 绑定自定义域名 `static.ai520.wiki`
   - 因为 `ai520.wiki` 已备案，这一步直接通过
3. 进入 bucket → 跨域设置（CORS）→ 新增规则
   - 来源：`*`
   - 方法：`GET, HEAD`
   - 允许 headers：`*`
4. 创建 RAM 用户 + AccessKey
   - 控制台 → RAM 访问控制 → 用户 → 创建
   - 给该用户授权 `AliyunOSSFullAccess`（或更细粒度的 bucket 级权限）
   - 拿到 AccessKeyId / AccessKeySecret
5. 把 AccessKey 填入 [.env.production.local](.env.production.local) 的 `ALIYUN_OSS_ACCESS_KEY_ID` / `ALIYUN_OSS_ACCESS_KEY_SECRET`

- [ ] **Step 2: 加载所有正式凭证**

Run: `set -a; source .env.production.local; set +a; echo "OSS=$ALIYUN_OSS_BUCKET, SIGN=$APPLE_SIGNING_IDENTITY"`
Expected: 两个值都非空

> 此步若 `APPLE_SIGNING_IDENTITY` 仍是开发证书，意味着还没拿到 Developer ID Application。**Updater 可以先用本地开发证书跑通流程**（用户首次启动会被 Gatekeeper 警告），等以后申请到 Developer ID 再切换。

- [ ] **Step 3: 跑一次完整发版**

Run:
```bash
pnpm build:mac-arm
pnpm publish:update
```

Expected:
- 产物上传成功
- 终端输出 `[publish] done. latest.json -> https://static.ai520.wiki/fujisim/latest.json`

- [ ] **Step 4: 浏览器验证 latest.json**

Run: `curl -sI https://static.ai520.wiki/fujisim/latest.json | head -5`
Expected: 200 OK，Cache-Control 包含 `no-cache`

Run: `curl -s https://static.ai520.wiki/fujisim/latest.json | head -20`
Expected: 看到 JSON 内容，含 version / platforms / signature

- [ ] **Step 5: 把 package.json 的 version 改为 1.0.2，再跑一次**

Run: `pnpm version 1.0.2 --no-git-tag-version`
Expected: package.json 更新

Run: `pnpm build:mac-arm && pnpm publish:update`
Expected:
- prebuild 自动同步版本到 tauri.conf.json 和 Cargo.toml
- 产物版本号是 1.0.2
- OSS 上 `releases/1.0.2/` 目录新增

- [ ] **Step 6: 测试老版本（1.0.1）能否检测到更新**

打开 Task 20 中之前生成的 1.0.1 版本 .app（先备份）：

Run: `open <path-to-1.0.1-FujiSim.app>`
Expected: 启动 3 秒后 Toast 弹出"发现新版本 1.0.2"，点击下载安装能完成 → 重启后版本变成 1.0.2

如果 Toast 没弹：

- 检查 `~/Library/Logs/com.fujisim.app/` 下日志
- 检查 `tauri.conf.json` endpoint 是否正确
- 检查 minisign 公钥是否一致

- [ ] **Step 7: 不做 commit（本步骤无文件改动）**

---

## 自检验收清单

完成所有 task 后逐项核对：

- [ ] 设置页齿轮按钮可打开 dialog，4 个 tab 全部可访问
- [ ] 主题切换、语言切换、清缓存功能正常，重启后保留
- [ ] 设置数据存于 SQLite 的 `app_settings` 表（用 `sqlite3 ~/Library/Application\ Support/FujiSim/library.sqlite "SELECT * FROM app_settings;"` 验证）
- [ ] App 启动 3 秒后自动触发 updater 检查
- [ ] 设置页"更新"标签的"立即检查"按钮可手动触发
- [ ] 自动检查 / 询问安装 / 跳过版本管理三项偏好持久化生效
- [ ] `pnpm version 1.0.x` + `pnpm build:mac` 自动同步版本号到 tauri.conf.json 和 Cargo.toml
- [ ] `pnpm publish:update` 把 .tar.gz / .sig / .dmg 上传 OSS 并生成正确的 latest.json
- [ ] 老版本能识别新版本并完成端到端升级
- [ ] cargo clippy 无警告
- [ ] pnpm tsc --noEmit 0 错误

## 已知后置工作（不在本计划内）

参见 [docs/superpowers/specs/2026-05-22-auto-update-future-work-todo.md](../specs/2026-05-22-auto-update-future-work-todo.md)：

1. Apple Developer ID Application 证书申请 + 公证（用户已知，待申请后切换 .env.production.local）
2. Windows / Linux 平台支持
3. 增量更新
4. 多语言通知
5. 密钥轮换
6. 应用内回滚
7. CI/CD 自动发版

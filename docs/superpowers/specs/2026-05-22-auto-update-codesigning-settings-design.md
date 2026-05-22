# 自动更新 + 代码签名 + 设置页 设计文档

**创建日期**：2026-05-22
**状态**：已批准设计，待实施
**作者**：FujiSim 开发组

---

## 1. 背景与目标

FujiSim 当前版本 `1.0.1` 已具备基础桌面图像处理能力，但缺少自动更新机制——用户必须手动到分发渠道下载新版本，发版后老版本无法自动升级。本设计为：

1. 启用 macOS Apple Developer 证书签名 + 公证流程，让产物可以分发给任何 Mac 用户
2. 接入 Tauri Updater 插件，让用户能在 App 内自动获取并安装新版本
3. 顺势开发一个**完整设置页**，把现有散落在 Sidebar dropdown 里的"切主题/切语言/清缓存"功能整合进去，并新增"更新"和"关于"两个标签页

## 2. 整体架构

四个相互独立的子系统：

```
┌──────────────────────────────────────────────────────────────────┐
│  ① 签名子系统（macOS 代码签名 + Apple 公证）                       │
│     - .env.local：本地开发证书（自测用）                           │
│     - .env.production.local：Developer ID + 公证凭证 + Tauri 私钥 │
└──────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  ② Updater 客户端（Rust + 前端）                                   │
│     - tauri-plugin-updater 接入 + 公钥编入二进制                   │
│     - useUpdater hook 状态机                                      │
│     - UpdaterBootstrap 启动 3 秒后自动检查                         │
│     - UpdateToast 通用提示组件                                     │
│     - 设置页"更新"标签：手动检查 + 偏好设置 + 跳过版本管理          │
└──────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  ③ 设置页（SQLite 持久化）                                         │
│     - app_settings(key, value, updated_at) 单表 KV                │
│     - 五个标签：通用 / 缓存 / 更新 / 关于（外观留占位）             │
│     - useSettings hook 异步加载，默认值兜底                        │
│     - 现有主题/语言/清缓存功能从 Sidebar 迁移过来                   │
└──────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  ④ 分发产物 + 上传流程                                             │
│     - 阿里云 OSS（华南1·深圳）+ static.ai520.wiki 自定义域名       │
│     - prebuild:* 钩子自动同步版本号                                │
│     - publish:update 脚本生成 latest.json + 上传 OSS              │
└──────────────────────────────────────────────────────────────────┘
```

## 3. 密钥与凭证体系

**两套独立的签名密钥**（最容易踩坑的地方）：

| 用途 | 密钥来源 | 验证方 | 失败后果 |
|---|---|---|---|
| macOS 代码签名 | Apple 颁发的 Developer ID 证书 | Apple Gatekeeper | App 装不上、被警告 |
| Updater 包签名 | Tauri CLI 自生成的 Ed25519/minisign | Tauri updater 客户端 | 客户端拒绝接受更新包 |

**已完成**：

- ✅ 本地开发证书已配置在 `.env.local`（仅自测用）
- ✅ Tauri 密钥对已生成并落盘 `~/.tauri/fujisim.key{,.pub}`
- ✅ Tauri 私钥已存入 `.env.production.local` 的 `TAURI_SIGNING_PRIVATE_KEY`
- ⏳ Tauri 私钥密码 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 待用户填入
- ⏳ Apple Developer ID Application 证书待用户申请

**离线备份要求**：`~/.tauri/fujisim.key{,.pub}` 必须立即备份至 U 盘 / 1Password 等离线介质。一旦丢失，老用户将永远无法接收新更新。

## 4. 子系统 ① ：签名

### 4.1 文件配置

`.env.local`（本地自测，已存在）：

```bash
APPLE_SIGNING_IDENTITY="Apple Development: 2787716172@qq.com (W4T9X727L6)"
```

`.env.production.local`（正式分发，已部分填充）：

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: <YOUR_NAME> (W4T9X727L6)"
APPLE_API_ISSUER=""
APPLE_API_KEY=""
APPLE_API_KEY_PATH=""
TAURI_SIGNING_PRIVATE_KEY="<已填入>"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<待用户填入>"
ALIYUN_OSS_ACCESS_KEY_ID=""
ALIYUN_OSS_ACCESS_KEY_SECRET=""
ALIYUN_OSS_BUCKET="fujisim-updates"
ALIYUN_OSS_REGION="oss-cn-shenzhen"
ALIYUN_OSS_DOMAIN="static.ai520.wiki"
```

`.gitignore` 已包含 `*.local`，自动忽略上述两个文件。

### 4.2 加载方式

```bash
set -a; source .env.production.local; set +a
pnpm build:mac
```

或通过 direnv 自动加载（可选）。

## 5. 子系统 ② ：Updater 客户端

### 5.1 Rust 端

**`src-tauri/Cargo.toml`** 新增：

```toml
tauri-plugin-updater = "2"
```

**`src-tauri/src/lib.rs`** 注册插件：

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

**`src-tauri/capabilities/default.json`** 加权限：

```json
"updater:default"
```

**`src-tauri/tauri.conf.json`** 新增：

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://static.ai520.wiki/fujisim/latest.json"
    ],
    "pubkey": "<从 ~/.tauri/fujisim.key.pub 读出>",
    "windows": { "installMode": "passive" }
  }
}
```

### 5.2 前端 Hook

**`src/hooks/use-updater.ts`** 单一职责：状态机 + 触发动作

```ts
type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes: string }
  | { kind: 'downloading'; progress: number }
  | { kind: 'ready' }
  | { kind: 'up-to-date' }
  | { kind: 'error'; message: string };

export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  const checkForUpdates = useCallback(async (silent = false) => { ... }, []);
  const downloadAndInstall = useCallback(async () => { ... }, []);
  const skipVersion = useCallback((version: string) => { ... }, []);
  const cancelSkip = useCallback((version: string) => { ... }, []);
  return { state, checkForUpdates, downloadAndInstall, skipVersion, cancelSkip };
}
```

`silent: true` = 启动自动检查，失败不报错；`silent: false` = 用户主动点，要给反馈。

### 5.3 启动自动检查

**`src/components/UpdaterBootstrap.tsx`** 挂在 App 根组件，启动 3 秒后调用 `checkForUpdates(true)`。

### 5.4 Toast 提示

**`src/components/UpdateToast.tsx`** 基于 `@radix-ui/react-toast`（已有依赖），按 `state.kind` 切换 UI：

| state.kind | UI |
|---|---|
| idle / checking / up-to-date | 不显示（启动时静默） |
| available | "1.0.2 已发布" + [立即更新] [稍后] [跳过] |
| downloading | "下载中 45%" + 进度条 |
| ready | "下载完成" + [立即重启] |
| error | 静默（启动）/ 红色 toast（手动） |

"跳过此版本"调用 `skipVersion(version)`，写入 `app_settings` 的 `update.skipped_versions` JSON 数组。

## 6. 子系统 ③ ：设置页

### 6.1 入口

复用 `src/components/Sidebar.tsx:145` 的齿轮按钮——把当前的 dropdown 改为直接 `onClick={() => setSettingsOpen(true)}`，删掉 `DropdownMenu` 包裹。

### 6.2 SQLite 持久化

**新增表**（在 `src-tauri/src/db/mod.rs` 的 `run_migrations` 里加）：

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**新增 Rust 模块**：`src-tauri/src/db/app_settings.rs`

```rust
pub async fn get(pool: &SqlitePool, key: &str) -> Result<Option<String>>;
pub async fn set(pool: &SqlitePool, key: &str, value: &str) -> Result<()>;
pub async fn delete(pool: &SqlitePool, key: &str) -> Result<()>;
pub async fn get_all(pool: &SqlitePool) -> Result<HashMap<String, String>>;
```

**新增 IPC 命令**（在 `src-tauri/src/ipc.rs`）：`get_setting / set_setting / delete_setting / get_all_settings`，前端 `src/api.ts` 加封装。

### 6.3 设置项 key 命名

```
ui.theme            = "light" | "dark"
ui.language         = "zh" | "en"
update.auto_check          = "true" | "false"
update.confirm_install     = "true" | "false"
update.skipped_versions    = JSON 数组字符串
update.last_check          = ISO 时间戳
```

默认值（用户未设置时）写在前端常量：

```ts
const DEFAULTS = {
  'ui.theme': 'light',
  'ui.language': 'zh',
  'update.auto_check': 'true',
  'update.confirm_install': 'true',
  'update.skipped_versions': '[]',
  'update.last_check': '',
};
```

### 6.4 useSettings Hook

**`src/hooks/use-settings.ts`**：

```ts
export function useSettings() {
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);

  useEffect(() => {
    api.getAllSettings().then((kv) => {
      setSettings(parseSettings(kv));
      setLoaded(true);
    });
  }, []);

  const update = useCallback(async <K extends keyof Settings>(
    key: K, value: Settings[K]
  ) => {
    await api.setSetting(key, JSON.stringify(value));
    setSettings((s) => ({ ...s, [key]: value }));
  }, []);

  return { settings, update, loaded };
}
```

主题/语言加载完成后异步应用——冷启动可能有几十毫秒闪烁，可接受。

### 6.5 现有功能迁移

`src/store.ts` 的 `theme/language/toggleTheme/toggleLanguage` 全部移除，改由 `useSettings` 的 `update('ui.theme', 'dark')` 驱动。`Sidebar.tsx` 里相关代码删除。

`src/components/ClearCacheDialog.tsx` 内容**整体迁入** `src/components/Settings/tabs/CacheTab.tsx`，原文件删除。

### 6.6 文件结构

```
src/components/Settings/
├─ SettingsDialog.tsx          ~120 行  容器，Tab 路由
├─ tabs/
│  ├─ GeneralTab.tsx           ~80  行  主题、语言
│  ├─ CacheTab.tsx             ~80  行  从 ClearCacheDialog 迁移
│  ├─ UpdateTab.tsx            ~150 行  更新检查 + 偏好 + 跳过版本
│  └─ AboutTab.tsx             ~80  行  版本号、官网、license
└─ index.ts                            导出 SettingsDialog
```

每个文件均控制在 500 行硬限内。

### 6.7 国际化

`src/i18n/zh.ts` 和 `en.ts` 新增 `settings.*` 段：

```ts
settings: {
  title: "设置",
  tabs: { general: "通用", cache: "缓存", update: "更新", about: "关于" },
  general: {
    theme: "主题", themeLight: "浅色", themeDark: "深色",
    language: "语言", chinese: "中文", english: "English"
  },
  update: {
    currentVersion: "当前版本",
    lastCheck: "最后检查",
    checkNow: "立即检查更新",
    autoCheck: "启动时自动检查更新",
    confirmInstall: "下载更新前询问",
    skippedVersions: "已跳过的版本",
    cancelSkip: "取消跳过",
    states: {
      checking: "检查中...",
      available: "发现新版本 {{version}}",
      downloading: "下载中 {{progress}}%",
      ready: "立即重启应用",
      upToDate: "已是最新版本",
      error: "检查失败：{{message}}"
    }
  },
  about: {
    version: "版本",
    website: "官网",
    websiteUrl: "https://static.ai520.wiki",
    license: "许可证"
  }
}
```

## 7. 子系统 ④ ：版本管理与 OSS 分发

### 7.1 版本管理脚本

**`scripts/bump-version.mjs`**（约 60 行）：

输入：从 `package.json` 读 `version`
输出：

1. 写入 `src-tauri/tauri.conf.json` 的 `version` 字段
2. 写入 `src-tauri/Cargo.toml` 的 `[package].version` 字段（**当前没有，需补上**）

**`package.json`** 脚本调整：

```json
"version:sync": "node scripts/bump-version.mjs",
"prebuild:mac": "pnpm version:sync",
"prebuild:mac-arm": "pnpm version:sync",
"prebuild:mac-x64": "pnpm version:sync",
"prebuild:win": "pnpm version:sync"
```

`prebuild:*` 是 npm 标准钩子，运行 `build:mac` 前自动跑 `version:sync`。

### 7.2 OSS 文件布局

```
static.ai520.wiki/fujisim/
├── latest.json
└── releases/
    ├── 1.0.1/
    │   ├── FujiSim_1.0.1_universal.app.tar.gz
    │   ├── FujiSim_1.0.1_universal.app.tar.gz.sig
    │   └── FujiSim_1.0.1_universal.dmg
    └── 1.0.2/
        └── ...
```

### 7.3 latest.json 格式

```json
{
  "version": "1.0.2",
  "notes": "修复了若干已知问题",
  "pub_date": "2026-05-22T20:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<minisign 签名>",
      "url": "https://static.ai520.wiki/fujisim/releases/1.0.2/FujiSim_1.0.2_universal.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "<同上 universal 包>",
      "url": "https://static.ai520.wiki/fujisim/releases/1.0.2/FujiSim_1.0.2_universal.app.tar.gz"
    }
  }
}
```

### 7.4 上传脚本

**`scripts/publish-update.mjs`**（约 100 行）：

- 依赖 `ali-oss`（开发依赖）
- 从 `.env.production.local` 读 OSS 凭证
- 自动收集 `src-tauri/target/.../bundle/macos/*.app.tar.gz{,.sig}` 和 `*.dmg`
- 生成 `latest.json` 并上传到 OSS
- `latest.json` 设置 `Cache-Control: no-cache, max-age=0`
- `releases/*` 设置 `Cache-Control: max-age=2592000`（30 天）

`package.json` 增加：

```json
"publish:update": "node scripts/publish-update.mjs"
```

### 7.5 标准发版流程

```bash
# 1. 改版本号
pnpm version 1.0.2 --no-git-tag-version

# 2. 加载证书 + 打包
set -a; source .env.production.local; set +a
pnpm build:mac

# 3. 验证签名 + 公证
codesign -dv --verbose=4 src-tauri/target/universal-apple-darwin/release/bundle/macos/FujiSim.app
spctl -a -vv src-tauri/target/universal-apple-darwin/release/bundle/macos/FujiSim.app

# 4. 上传到 OSS
pnpm publish:update
```

### 7.6 备案与域名

`ai520.wiki` 已备案，可直接在阿里云 OSS 控制台绑定 `static.ai520.wiki` 自定义域名，无需额外手续。OSS region 选 `oss-cn-shenzhen`（华南1·深圳）。

### 7.7 CDN 缓存策略

| 文件 | Cache-Control |
|---|---|
| `latest.json` | `no-cache, max-age=0` |
| `releases/*.tar.gz` | `public, max-age=2592000`（30 天） |
| `releases/*.sig` | `public, max-age=2592000` |
| `releases/*.dmg` | `public, max-age=2592000` |

URL 带版本号永不变，长缓存安全。

## 8. 测试策略

### 8.1 签名验证

```bash
codesign -dv --verbose=4 <FujiSim.app 路径>
spctl -a -vv <FujiSim.app 路径>
```

### 8.2 Updater 端到端测试

1. 在测试 OSS bucket 上传 `latest.json`（version 故意写大于当前）
2. 临时把 `tauri.conf.json` 的 endpoint 指向测试 bucket
3. 启动 App，验证：
   - 启动 3 秒后 Toast 弹出
   - 点"立即更新" → 下载 → 重启 → 新版本运行
   - 点"跳过" → 下次启动不再弹
   - 设置页"取消跳过"功能正常

### 8.3 设置页测试

- 主题/语言切换持久化通过 SQLite，重启后保留
- 清缓存功能与原 ClearCacheDialog 行为一致
- 默认值在 `app_settings` 为空时正确生效

## 9. 实施顺序

按依赖关系倒推：

1. **基础设施**：`app_settings` 表 + Rust 模块 + IPC 命令 + `useSettings` hook
2. **设置页骨架**：SettingsDialog + 4 个 Tab 文件结构 + i18n
3. **现有功能迁移**：主题/语言/清缓存从 Sidebar 移入设置页
4. **Updater 接入**：Rust 端插件 + capabilities + tauri.conf.json
5. **Updater UI**：useUpdater hook + UpdaterBootstrap + UpdateToast
6. **设置页"更新"标签**：复用 useUpdater，加偏好开关
7. **版本管理脚本**：bump-version.mjs + prebuild 钩子
8. **OSS 上传脚本**：publish-update.mjs + 阿里云 OSS 配置
9. **关于标签 + 网站链接**

每一步独立可测试，可分别 commit。

## 10. 已知限制 / 留待后续

- **Windows / Linux 支持**：本设计聚焦 macOS。Windows 的 NSIS 安装包签名走另一套流程（EV 证书或 SignTool），后续单独 spec
- **增量更新**：Tauri updater 当前下载完整包。如需 delta patch，需引入 `tauri-plugin-updater` 的 `installer` mode 或自定义实现
- **多语言通知文案**：`latest.json` 的 `notes` 字段单语，多语言展示需要扩展协议（例如 `notes.zh / notes.en`），后续可加
- **签名密钥轮换**：当前公钥写死在二进制。如需密钥轮换，需要先发支持多公钥的版本作为过渡
- **回滚机制**：当前没有"装错版本一键回滚"功能。用户只能手动重装老版本
- **CI/CD**：发版仍是手动流程。后续可上 GitHub Actions（即使仓库私有）或本地 Makefile 自动化

## 11. 验收标准

- [ ] `pnpm build:mac` 在加载 `.env.local` 后产物有合法 Apple 开发证书签名
- [ ] `pnpm build:mac` 在加载 `.env.production.local` 后产物有合法 Developer ID 签名 + 公证 + minisign 签名
- [ ] App 启动 3 秒后自动检查更新，发现新版弹 Toast
- [ ] Toast 上"立即更新"可下载、安装、重启进入新版本
- [ ] Toast 上"跳过此版本"持久化生效，下次启动不弹
- [ ] 设置页四个标签全部可访问，主题/语言/清缓存功能与原行为一致
- [ ] 设置页"更新"标签的"立即检查"按钮可手动触发
- [ ] `pnpm version 1.0.2` + `pnpm build:mac` 自动同步版本号到 `tauri.conf.json` 和 `Cargo.toml`
- [ ] `pnpm publish:update` 把产物上传到 `static.ai520.wiki/fujisim/` 并生成正确的 `latest.json`
- [ ] 老版本（1.0.1）能识别新版本（1.0.2）并完成端到端升级


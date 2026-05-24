# 预设分类与 LUT 归位设计文档

- 日期：2026-05-24
- 范围：编辑页左侧「预设」面板（`src/components/Editor/PresetList.tsx` 及相关后端）
- 状态：设计已确认，等待实现

## 1. 背景

当前编辑页布局：

- 左侧 `PresetList`：上方「推荐 / 我的」两个 tab，下方搜索框 + 列表，仅展示
  `filter_presets` 表中的内置/自定义预设。
- 右侧 `FilterPanel` 「胶片模拟」下拉：富士内置模拟 + 用户导入的 LUT 平铺，
  并提供「导入文件 / 导入文件夹」入口。

存在的问题：

1. LUT 导入入口埋在右侧调整面板里，与「预设」语义割裂；
2. 「我的」tab 下条目随用户增多变成扁平大列表，无组织手段；
3. 保存预设时无法分组归档。

本期目标：把 LUT 导入入口与展示位移到左侧预设面板，并引入「分类」概念
统一组织自定义预设和导入的 LUT。

## 2. 用户故事

1. 我要从右侧调整面板搬掉 LUT 导入入口，集中在左侧预设面板的 `+` 菜单里。
2. 我要在「我的」预设面板里看到自己导入的 LUT，可以像选预设一样一键应用。
3. 我要把预设和 LUT 按自定义分类组织（如「合照」「胶片日记」），并随时新建/
   重命名/删除分类。
4. 我要点搜索图标后单独进入搜索态，输入关键字跨分类查找，按返回回到默认列表。
5. 我要在导入 LUT 时为这一批 LUT 选择目标分类（默认「不分类」）。
6. 我要在保存预设时为它选择目标分类（默认「不分类」）。

## 3. 数据模型

### 3.1 新表 `preset_categories`

```sql
CREATE TABLE IF NOT EXISTS preset_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_preset_categories_sort
    ON preset_categories(sort_order);
```

- `name UNIQUE` 由数据库强制唯一性；后端 `create_preset_category` /
  `rename_preset_category` 在写入前显式检查并返回业务错误，避免依赖 SQLite 的
  约束错误抛到前端。
- `sort_order` 本期不暴露 UI（拖拽排序在范围外），但保留字段以便后续无迁移
  扩展。前端展示时排序键为 `(sort_order ASC, name ASC)`。

### 3.2 既有表新增列

```sql
ALTER TABLE filter_presets ADD COLUMN category_id INTEGER;
ALTER TABLE user_luts      ADD COLUMN category_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_filter_presets_category
    ON filter_presets(category_id);
CREATE INDEX IF NOT EXISTS idx_user_luts_category
    ON user_luts(category_id);
```

- `category_id IS NULL` 即「未分类」。
- 不在 SQLite 层声明外键：`ALTER TABLE ADD COLUMN ... REFERENCES ...` 在
  SQLite 中并不会启用真正的外键约束（要走「重建表」流程才行），与项目现有
  增量迁移策略冲突。改为**应用层在 `delete_preset_category` 中显式
  `UPDATE filter_presets/user_luts SET category_id = NULL WHERE category_id = ?`**，
  并把这两条 UPDATE 与 DELETE 包在同一个事务中。
- 增量迁移走 `db/mod.rs::run_migrations` 现有的「ALTER TABLE 失败时忽略」
  模式；上线时老数据全部 NULL。

### 3.3 Rust 数据结构

`src-tauri/src/db/preset_categories.rs`（新文件，约 120 行）：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PresetCategory {
    pub id: i64,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<PresetCategory>>;
pub async fn create(pool: &SqlitePool, name: &str) -> Result<PresetCategory>;
pub async fn rename(pool: &SqlitePool, id: i64, name: &str) -> Result<PresetCategory>;
pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()>;
pub async fn name_exists(pool: &SqlitePool, name: &str, exclude_id: Option<i64>) -> Result<bool>;
```

`presets.rs` / `user_luts.rs` 的结构体新增 `pub category_id: Option<i64>`，
对应 `INSERT` / `UPDATE` 改造、新增 `set_category` 函数。

## 4. IPC 命令

新增（`src-tauri/src/ipc.rs`）：

| 命令 | 入参 | 出参 |
| --- | --- | --- |
| `list_preset_categories` | — | `Vec<PresetCategory>` |
| `create_preset_category` | `name: String` | `PresetCategory` |
| `rename_preset_category` | `id: i64, name: String` | `PresetCategory` |
| `delete_preset_category` | `id: i64` | `()` |
| `check_preset_category_name_exists` | `name: String, excludeId?: i64` | `bool` |
| `set_preset_category` | `presetId: i64, categoryId?: i64` | `()` |
| `set_user_lut_category` | `lutId: i64, categoryId?: i64` | `()` |

修改：

- `import_luts(paths: Vec<String>, categoryId?: i64)`
- `import_luts_from_dir(dir: String, categoryId?: i64)`
- `save_preset(preset: NewFilterPreset)`：`NewFilterPreset` 增加 `category_id?: i64`

错误约定：重名场景统一返回 `AppError::Conflict("该分类名已存在")`；前端按
`AppError` 字符串识别即可（与 `check_album_name_exists` 现有约定保持一致，
真正落库前 UI 也会读 `check_preset_category_name_exists` 做即时校验）。

## 5. 前端类型与状态

### 5.1 `src/types.ts`

```ts
export type PresetCategory = {
  id: number;
  name: string;
  sort_order: number;
  created_at: string;
};

// 既有类型扩展
export type FilterPreset      = { /* ...原字段..., */ category_id: number | null };
export type UserLut           = { /* ...原字段..., */ category_id: number | null };
export type NewFilterPreset   = Omit<FilterPreset, "id" | "created_at" | "is_builtin">
                                & { is_builtin: boolean };
```

### 5.2 `src/api.ts`

- 新增上面 7 个命令的薄封装。
- `importLuts(paths, categoryId?)`、`importLutsFromDir(dir, categoryId?)`、
  `savePreset(preset)`（preset 内含 `category_id`）。

### 5.3 `src/store.ts`

新增切片：

```ts
type PresetCategoryState = {
  categories: PresetCategory[];
  refreshCategories: () => Promise<void>;
  createCategory: (name: string) => Promise<PresetCategory>;
  renameCategory: (id: number, name: string) => Promise<void>;
  deleteCategory: (id: number) => Promise<void>;
  setPresetCategory: (presetId: number, categoryId: number | null) => Promise<void>;
  setUserLutCategory: (lutId: number, categoryId: number | null) => Promise<void>;
};
```

`createCategory` 抛后端 Conflict 错误时由 UI 调用方处理。删除/重命名后
`refreshCategories` + `refreshPresets` + `refreshUserLuts` 一并刷新。

## 6. 组件拆分

把现有单文件 `src/components/Editor/PresetList.tsx` 重构为目录：

```
src/components/Editor/PresetList/
├── index.tsx              # 入口：组装 Header + Tabs + 列表
├── PresetListHeader.tsx   # 标题栏：搜索 icon ↔ 输入框、+ 菜单
├── PresetGroupedList.tsx  # 「我的」分组列表
├── PresetCard.tsx         # 单条预设/LUT 卡片
├── CategoryDialog.tsx     # 新建/重命名分类弹框
└── ImportLutDialog.tsx    # 导入 LUT 选择分类弹框
```

每个文件目标 < 200 行；旧 `PresetList.tsx` 由 `PresetList/index.tsx` 替代
（外部导入路径 `@/components/Editor/PresetList` 不变）。

### 6.1 `PresetListHeader`

默认态布局：

```
预设 ⓘ                                 🔍  +
```

行为：

- 🔍 点击 → 整行替换为 `← [输入框] ✕`，自动 focus。`←` / Esc 回到默认态并清空搜索；
  `✕` 仅清空搜索内容，不退出搜索态。
- `+` 点击 → 弹出 DropdownMenu：
  - 「导入预设 →」（`DropdownMenuSub`，子菜单：导入文件 / 导入文件夹）
  - 「新建分类」 → 打开 `CategoryDialog` (`mode="create"`)
- 「推荐」tab 下也允许搜索（仅过滤内置预设），但隐藏 `+`，避免「在推荐 tab 创建
  分类」造成歧义。

### 6.2 `PresetGroupedList`

仅在「我的」tab 渲染：

1. 把 `presets`（`is_builtin=0`）和 `userLuts` 合并为统一的「条目」列表，每条
   带 `kind: "preset" | "lut"`、`category_id`。
2. 按 `category_id` 分桶：先「未分类」桶，再按 `categories` 顺序遍历。
3. 每桶顶部渲染 `▼ 分类名 (N)`，可点击折叠/展开（折叠状态保存在 component
   local state，一次会话内有效）；分类标题右键菜单：「重命名」「删除」。
   - 「未分类」桶不带右键菜单；
   - 删除分类时 confirm 弹框「删除分类后，分类下条目将回到「未分类」，确定
     删除吗？」。
4. 桶体：`PresetCard` 列表。
5. 空桶提示：`该分类下暂无预设`。
6. 搜索时按桶过滤，无命中桶整体隐藏；命中条目对关键字做高亮（CSS `<mark>`）。

「推荐」tab 维持现有平铺布局，仅做关键字过滤。

### 6.3 `PresetCard`

```
[icon] 名字 ………………………………………………………………………
```

- 图标：预设 = `SlidersHorizontal`，LUT = `Layers`（lucide-react）。
- 选中态：预设按 `filter.base_simulation === preset.base_simulation` 判定；LUT 按
  `filter.lut_file_path === lut.file_path` 判定。
- 点击：
  - 预设 → 调 store 的 `applyPreset(preset)`。
  - LUT → `setFilter({ base_simulation: PASS_THROUGH_SIM, lut_file_path: lut.file_path })`。
- 右键菜单 (`ContextMenu`)：
  - 「移动到分类...」→ 列出 `不分类 + 所有 categories`，点击后调
    `setPresetCategory` / `setUserLutCategory`；
  - 「重命名」（仅自定义预设，本期不实现，见 §11）；
  - 「删除」→ 自定义预设调 `deletePreset`，LUT 调 `deleteUserLut`。

### 6.4 `CategoryDialog`

按图 3：

- 标题：`新建分类` 或 `重命名分类`（按 `mode` 区分）。
- 输入框：`placeholder="输入分类名称"`，`maxLength={20}`，右下角实时显示 `N/20`。
- 输入失焦或停止输入 300ms 后调 `check_preset_category_name_exists` 做即时
  校验，已存在时下方显示红字「该分类名已存在」，「确定」按钮 disabled。
- 「确定」→ `await createCategory(name)` / `renameCategory(id, name)`：
  - Conflict 错误（即时校验未捕获到的并发情况）→ 输入框下方红字提示，不关弹框；
  - 成功 → 关弹框，调 `refreshCategories`。
- 「取消」→ 关弹框。

### 6.5 `ImportLutDialog`

点击「导入预设 → 导入文件 / 导入文件夹」时**先**弹出此弹框：

- 标题：`导入 LUT`
- 字段：`分类`（下拉，默认「不分类」+ 所有 categories）
- 「取消」→ 关弹框；
- 「下一步」→ 关弹框，再调原 `openDialog({ filters: [...cube...] })` 或
  `openDialog({ directory: true })`，选完后调
  `api.importLuts(paths, categoryId)` / `api.importLutsFromDir(dir, categoryId)`，
  完成后 `refreshUserLuts`。

如果用户在系统选择器里取消，整个流程静默结束（不需要回到 ImportLutDialog）。

## 7. FilterPanel 修改

`src/components/FilterPanel.tsx`:

1. 删除「胶片模拟」下拉的「用户预设 / LUT」分组，仅保留「系统预设」+
   `Pass-Through`。
2. 删除「导入 LUT」DropdownMenu 入口（含 `importLuts` / `importLutsFromDir`
   两个内部函数）。
3. 「保存预设」弹框新增字段：
   - `分类` 下拉（默认「不分类」+ 所有 categories）；
   - 提交时 `category_id` 一并送给后端。

`base_simulation === PASS_THROUGH_SIM && lut_file_path` 的提示文案保持。

## 8. i18n

新增 key（`src/i18n/zh.ts` / `en.ts`）：

```
editor.presetList.searchPlaceholder
editor.presetList.importPreset            // "导入预设"
editor.presetList.importFiles             // "导入文件"
editor.presetList.importDir               // "导入文件夹"
editor.presetList.newCategory             // "新建分类"
editor.presetList.renameCategory          // "重命名分类"
editor.presetList.uncategorized           // "未分类"
editor.presetList.emptyCategory           // "该分类下暂无预设"
editor.presetList.categoryName            // "分类名"
editor.presetList.categoryNamePlaceholder // "输入分类名称"
editor.presetList.categoryNameExists      // "该分类名已存在"
editor.presetList.confirmDeleteCategory   // 确认弹框文案
editor.presetList.moveToCategory          // "移动到分类..."
editor.presetList.noCategory              // 下拉中的"不分类"
editor.presetList.importLutTitle          // "导入 LUT"
editor.presetList.next                    // "下一步"
filterPanel.savePresetCategory            // 保存预设弹框中的"分类"标签
```

旧 key（`filterPanel.importLut` / `filterPanel.importFiles` /
`filterPanel.importDir` 等）跟随 FilterPanel 变更一并清理。

## 9. 测试

### 9.1 后端单元测试

`src-tauri/src/db/preset_categories.rs` 内置 `#[cfg(test)] mod tests`：

- `create / list / rename / delete`
- `name_exists` 区分 `excludeId`
- `create` 同名重复返回错误
- 删除分类后关联预设/LUT 的 `category_id` 通过同事务 UPDATE 置 NULL，验证
  事务原子性（DELETE 失败时 UPDATE 不应生效）

### 9.2 前端单元测试

- `CategoryDialog`（vitest + RTL）：
  - 输入超过 20 字符被截断，右下计数 `20/20`；
  - 输入已存在分类名 → 即时校验红字 + 确定按钮禁用；
  - 提交成功后调 `onClose`。
- `PresetGroupedList`：
  - `presets` + `userLuts` + `categories` 已知输入，渲染分组顺序与计数；
  - 搜索关键字过滤：未命中分类整体隐藏，命中条目高亮；
  - 折叠/展开状态切换不影响其它分组。

### 9.3 手动 smoke 流程

1. 新建分类「合照」→ 出现在「我的」分组顶部（紧邻「未分类」之后）；
2. 在调整 tab 调参后保存为预设并选「合照」分类 → 列表中「合照」组下出现新预设；
3. 点 `+ → 导入预设 → 导入文件`，先弹分类选择，选「合照」，再选 .cube 文件 →
   导入完成的 LUT 出现在「合照」组内；
4. 点搜索 icon → 输入关键字 → 跨分类过滤；按返回退出搜索；
5. 「合照」右键 → 重命名为「合照精选」→ 列表标题更新；
6. 「合照精选」右键 → 删除 → 内容回到「未分类」组；
7. 右侧「胶片模拟」下拉确认无 LUT 列表、无导入入口。

## 10. 文件行数与拆分

| 文件 | 估计行数 |
| --- | --- |
| `db/preset_categories.rs` | ~120 |
| `db/presets.rs` 改动 | +30，仍在 200 内 |
| `db/user_luts.rs` 改动 | +30，仍在 100 内 |
| `db/mod.rs` 迁移 | +10 |
| `ipc.rs` 新增命令 | +60 |
| `PresetList/index.tsx` | ~80 |
| `PresetListHeader.tsx` | ~140 |
| `PresetGroupedList.tsx` | ~180 |
| `PresetCard.tsx` | ~120 |
| `CategoryDialog.tsx` | ~140 |
| `ImportLutDialog.tsx` | ~100 |
| `FilterPanel.tsx` 改动 | -40 +40，原文件继续在 500 行内 |

均落在项目 500 行硬限内。

## 11. 范围外

- 拖拽排序分类、拖拽预设跨分类。
- 预设/LUT 改名（保持现状，本期不动）。
- 「推荐」tab 下分类。
- 内置预设的分类绑定（始终 `category_id=NULL`，列表里不分组）。
- 与相册/收藏的联动。

## 12. 风险与回滚

- 数据库迁移失败：所有 `ALTER TABLE` / `CREATE INDEX` 走「失败忽略」模式，
  与现有迁移策略一致；老版本回滚后 `category_id` 列继续存在但不被读取。
- 重名校验竞态：即时校验 + 后端最终校验双层兜底，UI 显示清晰错误，不会落到
  数据库 UNIQUE 约束抛出未处理异常。
- 删除分类丢数据：`delete_preset_category` 在事务里先 `UPDATE
  filter_presets / user_luts SET category_id = NULL WHERE category_id = ?` 再
  `DELETE FROM preset_categories WHERE id = ?`，保证内容物只迁移分组、不删除；
  UI 弹确认框二次保护。

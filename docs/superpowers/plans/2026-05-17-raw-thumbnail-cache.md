# RAW 缩略图磁盘缓存 + 预览原图加速 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RAW/DNG 文件在素材列表中显示封面缩略图（批量预取、磁盘缓存、幂等）；「按住看原图」第二次起直接读磁盘，几乎零延迟。

**Architecture:** 后端新增 `generate_thumbnails` IPC 命令，串行提取 RAW 嵌入 JPEG 写盘到 `thumbnails/{id}.jpg`，每张完成后推 `thumbnail:done` 事件；`get_raw_thumbnail` 优先读磁盘缓存；前端 store 维护 `rawThumbnailReady` Set，`Thumb` 组件据此决定是否用 `convertFileSrc` 加载缩略图。

**Tech Stack:** Rust / Tauri IPC、tokio spawn_blocking、@tauri-apps/api/event listen、Zustand、React

---

## 文件变更地图

| 文件 | 操作 | 职责 |
|------|------|------|
| `src-tauri/src/ipc.rs` | 修改 | 新增 `generate_thumbnails`、`get_thumbnail_dir`；修改 `get_raw_thumbnail` 读磁盘缓存；修改 `clear_all_data` 清空缩略图目录 |
| `src-tauri/src/lib.rs` | 修改 | 在 `invoke_handler` 注册新命令 |
| `src/api.ts` | 修改 | 新增 `generateThumbnails`、`getThumbnailDir` 方法 |
| `src/store.ts` | 修改 | 新增 `thumbnailDir`、`rawThumbnailReady` 字段及相关 actions |
| `src/App.tsx` | 修改 | 启动时获取 thumbnailDir、监听 `thumbnail:done` 事件 |
| `src/components/AssetGrid.tsx` | 修改 | `Thumb` 组件读 `rawThumbnailReady` 决定缩略图 src |

---

## Task 1：后端——新增 `get_thumbnail_dir` 命令

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1：在 `ipc.rs` 末尾追加命令函数**

在 `ipc.rs` 文件末尾（`cleanup_watermark_file` 函数之后）追加：

```rust
/// 返回缩略图缓存目录的绝对路径，供前端拼接 convertFileSrc 使用。
#[tauri::command]
pub async fn get_thumbnail_dir(state: State<'_, SharedState>) -> Result<String> {
    Ok(state.thumbnail_dir.to_string_lossy().to_string())
}
```

- [ ] **Step 2：在 `lib.rs` 的 `invoke_handler` 里注册**

在 `lib.rs` 的 `tauri::generate_handler![...]` 列表里，找到 `ipc::get_raw_thumbnail,` 那行，在其后追加：

```rust
ipc::get_thumbnail_dir,
```

- [ ] **Step 3：编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

期望输出：`warning: ...` 若干，无 `error`。

- [ ] **Step 4：Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): 新增 get_thumbnail_dir 命令"
```

---

## Task 2：后端——修改 `get_raw_thumbnail` 走磁盘缓存

**Files:**
- Modify: `src-tauri/src/ipc.rs`（`get_raw_thumbnail` 函数，约第 854-874 行）

- [ ] **Step 1：替换 `get_raw_thumbnail` 函数体**

将现有的 `get_raw_thumbnail` 函数（整个函数）替换为以下实现：

```rust
/// 提取 RAW 文件中嵌入的最大 JPEG 缩略图，直接返回 base64 编码的 JPEG。
/// 优先读磁盘缓存（thumbnails/{id}.jpg），缓存命中时跳过解码，几乎零延迟。
/// 缓存不存在时提取并写盘，下次直接命中。
#[tauri::command]
pub async fn get_raw_thumbnail(
    state: State<'_, SharedState>,
    asset_id: i64,
) -> Result<PreviewResult> {
    let asset = assets::get(&state.pool, asset_id).await?;
    let path = std::path::PathBuf::from(&asset.file_path);
    let cache_path = state.thumbnail_dir.join(format!("{asset_id}.jpg"));

    tokio::task::spawn_blocking(move || {
        // 磁盘缓存命中：直接读文件
        let jpeg = if cache_path.exists() {
            std::fs::read(&cache_path)
                .map_err(|e| AppError::other(format!("thumbnail cache read: {e}")))?
        } else {
            // 提取并写盘，供下次命中
            let bytes = processing::raw::extract_raw_thumbnail(&path)?;
            if let Err(e) = std::fs::write(&cache_path, &bytes) {
                tracing::warn!(asset_id, error = %e, "get_raw_thumbnail: write cache failed");
            }
            bytes
        };

        let (width, height) = jpeg_dimensions(&jpeg).unwrap_or((0, 0));
        Ok(PreviewResult {
            mime: "image/jpeg".into(),
            data: general_purpose::STANDARD.encode(&jpeg),
            width,
            height,
        })
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}
```

- [ ] **Step 2：编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

期望：无 `error`。

- [ ] **Step 3：Commit**

```bash
git add src-tauri/src/ipc.rs
git commit -m "feat(ipc): get_raw_thumbnail 优先读磁盘缓存，缓存不存在时提取并写盘"
```

---

## Task 3：后端——新增 `generate_thumbnails` 批量生成命令

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1：在 `ipc.rs` 的 `get_thumbnail_dir` 函数之前追加事件载荷结构体和命令**

在 `get_thumbnail_dir` 函数定义之前插入：

```rust
/// `thumbnail:done` 事件载荷：单张缩略图写盘完成。
#[derive(Debug, Serialize, Clone)]
pub struct ThumbnailDonePayload {
    pub asset_id: i64,
}

/// 批量为 RAW/DNG 资产生成磁盘缩略图缓存。
///
/// 串行处理每张：已有缓存则跳过（幂等）；提取并写盘后推送 `thumbnail:done` 事件。
/// 全部处理完毕后推送 `thumbnail:all_done`（无载荷）。
/// 单张失败不中断整批，只记录 warning。
#[tauri::command]
pub async fn generate_thumbnails(
    state: State<'_, SharedState>,
    app: tauri::AppHandle,
    asset_ids: Vec<i64>,
) -> Result<()> {
    // 只取 is_raw=1 的资产，过滤无效 id（不存在的会被 get 忽略）
    let mut raw_assets = Vec::new();
    for id in &asset_ids {
        match assets::get(&state.pool, *id).await {
            Ok(a) if a.is_raw != 0 => raw_assets.push(a),
            _ => {}
        }
    }

    let thumbnail_dir = state.thumbnail_dir.clone();

    tokio::task::spawn_blocking(move || {
        for asset in raw_assets {
            let cache_path = thumbnail_dir.join(format!("{}.jpg", asset.id));
            if cache_path.exists() {
                // 缓存已存在，直接推送完成事件（前端据此更新 ready set）
                let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
                continue;
            }

            let src = std::path::PathBuf::from(&asset.file_path);
            match processing::raw::extract_raw_thumbnail(&src) {
                Ok(jpeg) => {
                    if let Err(e) = std::fs::write(&cache_path, &jpeg) {
                        tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: write failed");
                        continue;
                    }
                    let _ = app.emit("thumbnail:done", &ThumbnailDonePayload { asset_id: asset.id });
                }
                Err(e) => {
                    tracing::warn!(asset_id = asset.id, error = %e, "generate_thumbnails: extract failed");
                }
            }
        }
        let _ = app.emit("thumbnail:all_done", ());
    });

    Ok(())
}
```

- [ ] **Step 2：在 `lib.rs` 注册新命令**

在 `invoke_handler` 列表里 `ipc::get_thumbnail_dir,` 之后追加：

```rust
ipc::generate_thumbnails,
```

- [ ] **Step 3：编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

期望：无 `error`。

- [ ] **Step 4：Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): 新增 generate_thumbnails 批量生成缩略图，推送 thumbnail:done 事件"
```

---

## Task 4：后端——`clear_all_data` 联动清空缩略图目录

**Files:**
- Modify: `src-tauri/src/ipc.rs`（`clear_all_data` 函数，约第 1009-1026 行）

- [ ] **Step 1：在 `clear_all_data` 里追加清空缩略图目录的逻辑**

找到 `clear_all_data` 函数，在 `watermarks 目录整体清空` 的代码块之后（`create_dir_all` 之后）、`user_fonts` 清理之前，插入：

```rust
    // thumbnails 目录整体清空
    if state.thumbnail_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.thumbnail_dir);
        let _ = std::fs::create_dir_all(&state.thumbnail_dir);
    }
```

修改后 `clear_all_data` 中段应如下（展示上下文）：

```rust
    // watermarks 目录整体清空
    if state.watermark_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.watermark_dir);
        let _ = std::fs::create_dir_all(&state.watermark_dir);
    }
    // thumbnails 目录整体清空
    if state.thumbnail_dir.exists() {
        let _ = std::fs::remove_dir_all(&state.thumbnail_dir);
        let _ = std::fs::create_dir_all(&state.thumbnail_dir);
    }
    // 软删除所有字体记录，清空 fonts 目录
    user_fonts::delete_all(&state.pool).await?;
```

- [ ] **Step 2：编译验证**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```

期望：无 `error`。

- [ ] **Step 3：Commit**

```bash
git add src-tauri/src/ipc.rs
git commit -m "feat(ipc): clear_all_data 联动清空 thumbnails 目录"
```

---

## Task 5：前端——`api.ts` 新增两个方法

**Files:**
- Modify: `src/api.ts`

- [ ] **Step 1：在 `api` 对象里 `getRawThumbnail` 之后追加两个方法**

找到 `getRawThumbnail` 那行：

```ts
  /** 提取 RAW 文件嵌入的最大 JPEG 缩略图，速度远快于完整解码。 */
  getRawThumbnail: (assetId: number) =>
    invoke<PreviewResult>("get_raw_thumbnail", { assetId }),
```

在其后插入：

```ts
  /** 返回缩略图缓存目录的绝对路径（macOS 通常为 ~/Library/Application Support/FujiSim/thumbnails）。 */
  getThumbnailDir: () => invoke<string>("get_thumbnail_dir"),

  /**
   * 批量为 RAW 资产生成磁盘缩略图缓存（fire-and-forget）。
   * 每张完成后后端推送 `thumbnail:done` 事件；全部完成后推送 `thumbnail:all_done`。
   */
  generateThumbnails: (assetIds: number[]) =>
    invoke<void>("generate_thumbnails", { assetIds }),
```

- [ ] **Step 2：TypeScript 编译检查**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -20
```

期望：无输出（无类型错误）。

- [ ] **Step 3：Commit**

```bash
git add src/api.ts
git commit -m "feat(api): 新增 getThumbnailDir / generateThumbnails"
```

---

## Task 6：前端——Store 新增 thumbnailDir 和 rawThumbnailReady

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1：在 `AppState` type 里新增两个字段**

找到 `// ===== Actions =====` 注释行，在其之前追加：

```ts
  // ===== RAW 缩略图缓存 =====
  /** 后端缩略图目录的绝对路径，App 启动时从后端获取一次 */
  thumbnailDir: string | null;
  /** 已确认磁盘上有 {id}.jpg 缩略图文件的 asset id 集合 */
  rawThumbnailReady: Set<number>;
  setThumbnailDir: (dir: string) => void;
  markThumbnailReady: (assetId: number) => void;
  /** 清空 rawThumbnailReady（清除缓存后调用） */
  clearThumbnailReady: () => void;
```

- [ ] **Step 2：在 zustand 初始化对象里添加初始值和 action 实现**

在 `progress: null,` 那行之后，找到 `setQuery:` 之前，插入初始值：

```ts
  thumbnailDir: null,
  rawThumbnailReady: new Set<number>(),
```

然后在 `setSelectedWatermarkPresetId: (id) => set({ selectedWatermarkPresetId: id }),` 之后（`}));` 之前）追加 actions：

```ts
  setThumbnailDir: (dir) => set({ thumbnailDir: dir }),
  markThumbnailReady: (assetId) => {
    const next = new Set(get().rawThumbnailReady);
    next.add(assetId);
    set({ rawThumbnailReady: next });
  },
  clearThumbnailReady: () => set({ rawThumbnailReady: new Set() }),
```

- [ ] **Step 3：在 `refreshAssets` 完成后触发批量缩略图生成**

找到 `refreshAssets` action，在 `set({ assets: list, loading: false, ... })` 之后（`} catch` 之前）追加：

```ts
      // 后台预生成 RAW 缩略图（fire-and-forget）
      const rawIds = list.filter((a) => Boolean(a.is_raw)).map((a) => a.id);
      if (rawIds.length > 0) {
        api.generateThumbnails(rawIds).catch(() => {});
      }
```

- [ ] **Step 4：TypeScript 编译检查**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -20
```

期望：无输出。

- [ ] **Step 5：Commit**

```bash
git add src/store.ts
git commit -m "feat(store): 新增 thumbnailDir / rawThumbnailReady 及缩略图生成触发逻辑"
```

---

## Task 7：前端——App.tsx 初始化 thumbnailDir 并监听事件

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1：替换 `App.tsx` 全文为以下内容**

```tsx
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Sidebar } from "@/components/Sidebar";
import { AssetGrid } from "@/components/AssetGrid";
import { PreviewPanel } from "@/components/PreviewPanel";
import { FilterPanel } from "@/components/FilterPanel";
import { ExportDialog } from "@/components/ExportDialog";
import { Toaster } from "@/components/ui/toast";
import { useStore } from "@/store";
import { api } from "@/api";
import { cn } from "@/lib/utils";

export default function App() {
  const refreshAssets = useStore((s) => s.refreshAssets);
  const refreshFacets = useStore((s) => s.refreshFacets);
  const refreshPresets = useStore((s) => s.refreshPresets);
  const refreshUserLuts = useStore((s) => s.refreshUserLuts);
  const setThumbnailDir = useStore((s) => s.setThumbnailDir);
  const markThumbnailReady = useStore((s) => s.markThumbnailReady);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    refreshAssets();
    refreshFacets();
    refreshPresets();
    refreshUserLuts();
    // 获取缩略图目录路径，供 Thumb 组件拼接 convertFileSrc
    api.getThumbnailDir().then(setThumbnailDir).catch(() => {});
  }, [refreshAssets, refreshFacets, refreshPresets, refreshUserLuts, setThumbnailDir]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ asset_id: number }>("thumbnail:done", (e) => {
      markThumbnailReady(e.payload.asset_id);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [markThumbnailReady]);

  return (
    <div className="h-full w-full flex flex-col bg-zinc-950 text-zinc-200">
      <div className="flex-shrink-0 border-b border-zinc-800/60 bg-zinc-950/50">
        <Sidebar />
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="w-[360px] flex-shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800/60 overflow-hidden">
          <AssetGrid />
        </div>

        <div className="flex-1 flex flex-col min-w-0 bg-zinc-950">
          <PreviewPanel onExport={() => setExportOpen(true)} />
        </div>

        <div className="w-[320px] flex-shrink-0 flex flex-col bg-zinc-950/50 border-l border-zinc-800/60 overflow-hidden">
          <FilterPanel />
        </div>
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <Toaster />
    </div>
  );
}
```

- [ ] **Step 2：TypeScript 编译检查**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -20
```

期望：无输出。

- [ ] **Step 3：Commit**

```bash
git add src/App.tsx
git commit -m "feat(App): 初始化 thumbnailDir，监听 thumbnail:done 事件更新 store"
```

---

## Task 8：前端——AssetGrid Thumb 组件显示 RAW 缩略图

**Files:**
- Modify: `src/components/AssetGrid.tsx`

- [ ] **Step 1：在 `Thumb` 组件里从 store 读取 `rawThumbnailReady` 和 `thumbnailDir`**

找到 `Thumb` 函数开头，在 `const { t } = useTranslation();` 之后插入：

```tsx
  const rawThumbnailReady = useStore((s) => s.rawThumbnailReady);
  const thumbnailDir = useStore((s) => s.thumbnailDir);
```

- [ ] **Step 2：替换 `src` 的 `useMemo` 计算逻辑**

将现有的：

```tsx
  const src = useMemo(() => {
    if (asset.is_raw) return null;
    try {
      return convertFileSrc(asset.file_path);
    } catch {
      return null;
    }
  }, [asset.file_path, asset.is_raw]);
```

替换为：

```tsx
  const src = useMemo(() => {
    if (!asset.is_raw) {
      try { return convertFileSrc(asset.file_path); } catch { return null; }
    }
    // RAW：有磁盘缩略图时用 convertFileSrc，否则返回 null 显示图标占位
    if (rawThumbnailReady.has(asset.id) && thumbnailDir) {
      try { return convertFileSrc(`${thumbnailDir}/${asset.id}.jpg`); } catch { return null; }
    }
    return null;
  }, [asset.file_path, asset.is_raw, asset.id, rawThumbnailReady, thumbnailDir]);
```

- [ ] **Step 3：TypeScript 编译检查**

```bash
cd /Users/ry2019/private/FujiSim && npx tsc --noEmit 2>&1 | head -20
```

期望：无输出。

- [ ] **Step 4：Commit**

```bash
git add src/components/AssetGrid.tsx
git commit -m "feat(AssetGrid): RAW 文件有磁盘缩略图时显示封面图"
```

---

## Task 9：完整构建验证

- [ ] **Step 1：完整 Rust 构建**

```bash
cd /Users/ry2019/private/FujiSim/src-tauri && cargo build 2>&1 | tail -10
```

期望：`Finished dev [unoptimized + debuginfo] target(s) in ...`，无 `error`。

- [ ] **Step 2：启动开发服务器并手动测试**

```bash
cd /Users/ry2019/private/FujiSim && npm run tauri dev
```

手动验证：
1. 导入包含 RAW/DNG 文件的目录
2. 素材列表中 RAW 文件应逐张出现封面缩略图（不应全部是文件图标）
3. 点击一张 RAW 文件，预览面板加载滤镜预览
4. 按住「对比原图」按钮：第一次等待解码，松开后再次按下应几乎立即显示（读缓存）
5. 重启应用，缩略图应立即显示（不需要重新生成）
6. 进入设置清除缓存，缩略图消失，重新导入后再次生成

- [ ] **Step 3：最终 Commit（如有遗漏文件）**

```bash
git status
# 若有未提交文件
git add -A && git commit -m "chore: 补全 RAW 缩略图缓存相关遗漏文件"
```

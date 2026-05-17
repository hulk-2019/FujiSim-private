import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FolderOpen, Trash2, Pencil, FolderPlus, Plus, Search, RefreshCw, Files, ChevronDown, Sun, Moon } from "lucide-react";
import { api, type BatchProgress } from "@/api";
import type { Album } from "@/types";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function Sidebar() {
  const importing = useStore((s) => s.importing);
  const cameras = useStore((s) => s.cameras);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const refreshAssets = useStore((s) => s.refreshAssets);
  const refreshFacets = useStore((s) => s.refreshFacets);
  const setImporting = useStore((s) => s.setImporting);
  const selectedIds = useStore((s) => s.selectedIds);
  const clearSelection = useStore((s) => s.clearSelection);
  const progress = useStore((s) => s.progress);
  const setProgress = useStore((s) => s.setProgress);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);

  const [albums, setAlbums] = useState<Album[]>([]);
  const [newAlbumOpen, setNewAlbumOpen] = useState(false);
  const [newAlbum, setNewAlbum] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTemplate, setRenameTemplate] = useState("{date}_{camera}_{name}");
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTargetAlbum, setMoveTargetAlbum] = useState<string>("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [searchText, setSearchText] = useState("");

  useEffect(() => {
    api.listAlbums().then(setAlbums).catch(() => {});
  }, []);

  useEffect(() => {
    // 用 cancelled 标志兜底：listen 的 Promise 可能在组件卸载之后才 resolve，
    // 此时 unlisten 已经不会被 effect cleanup 调用，会导致事件回调持续触发不存在的 setProgress。
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen<BatchProgress>("export:progress", (e) => {
      setProgress(e.payload);
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setProgress]);

  const ids = useMemo(() => Array.from(selectedIds), [selectedIds]);

  async function pickAndImport() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") return;
    setImporting(true);
    try {
      const report = await api.importDirectory(selected, query.album_id ?? null);
      setImporting(false, { inserted: report.inserted, scanned: report.scanned });
      await Promise.all([refreshAssets(), refreshFacets()]);
    } catch (e) {
      console.error(e);
      setImporting(false);
    }
  }

  async function pickFilesAndImport() {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "tif", "tiff", "webp", "heic", "heif", "arw", "cr2", "cr3", "nef", "nrw", "raf", "rw2", "dng", "orf", "pef", "srw", "rwl", "sr2"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    setImporting(true);
    try {
      const report = await api.importFiles(paths, query.album_id ?? null);
      setImporting(false, { inserted: report.inserted, scanned: report.scanned });
      await Promise.all([refreshAssets(), refreshFacets()]);
    } catch (e) {
      console.error(e);
      setImporting(false);
    }
  }

  async function createAlbum() {
    if (!newAlbum.trim()) return;
    await api.createAlbum(newAlbum.trim());
    setNewAlbum("");
    setNewAlbumOpen(false);
    setAlbums(await api.listAlbums());
  }

  async function doRename() {
    if (ids.length === 0) return;
    await api.renameAssets(ids, renameTemplate);
    setRenameOpen(false);
    await refreshAssets();
  }

  async function doMove() {
    const albumId = Number(moveTargetAlbum);
    if (!albumId || ids.length === 0) return;
    await api.albumAdd(albumId, ids);
    // 若当前正在某个相册视图下，把素材从原相册移除，实现真正的"移动"语义
    if (query.album_id != null && query.album_id !== albumId) {
      await api.albumRemove(query.album_id, ids);
    }
    setMoveOpen(false);
    setMoveTargetAlbum("");
    await refreshAssets();
  }

  async function doDelete(trash: boolean) {
    if (ids.length === 0) return;
    await api.deleteAssets(ids, trash);
    setDeleteOpen(false);
    clearSelection();
    await refreshAssets();
  }

  return (
    <aside className="w-full px-4 py-2 bg-transparent flex items-center flex-wrap gap-4 text-sm relative z-10">
      {/* 导入与刷新 */}
      <div className="flex items-center gap-1 pr-4 border-r border-zinc-800/60">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button disabled={importing} size="sm" variant="default" className="h-8 whitespace-nowrap pr-2">
              <FolderOpen size={14} className="mr-1 flex-shrink-0" />
              {importing ? "导入中..." : "导入"}
              <ChevronDown size={12} className="ml-1 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={pickAndImport}>
              <FolderOpen size={13} />
              选择目录（递归扫描）
            </DropdownMenuItem>
            <DropdownMenuItem onClick={pickFilesAndImport}>
              <Files size={13} />
              选择文件（批量多选）
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button onClick={() => refreshAssets()} variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" title="刷新">
          <RefreshCw size={14} />
        </Button>
      </div>

      {/* 搜索 */}
      <div className="relative w-48 flex-shrink-0">
        <Search size={14} className="absolute left-2.5 top-2 text-zinc-500" />
        <Input
          placeholder="文件名 / 相机 / 镜头"
          className="h-8 pl-8 text-xs"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setQuery({ search: searchText || null });
          }}
        />
      </div>

      {/* 筛选 */}
      <div className="flex items-center gap-2 pr-4 border-r border-zinc-800/60">
        <Select
          value={query.camera_model ?? "_all"}
          onValueChange={(v) => setQuery({ camera_model: v === "_all" ? null : v })}
        >
          <SelectTrigger className="h-8 w-28 text-xs whitespace-nowrap overflow-hidden [&>span]:truncate">
            <SelectValue placeholder="相机" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">全部相机</SelectItem>
            {cameras.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(query.min_rating ?? 0)}
          onValueChange={(v) => setQuery({ min_rating: Number(v) || null })}
        >
          <SelectTrigger className="h-8 w-24 text-xs whitespace-nowrap overflow-hidden [&>span]:truncate">
            <SelectValue placeholder="星级" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">全部星级</SelectItem>
            <SelectItem value="1">≥ 1 星</SelectItem>
            <SelectItem value="2">≥ 2 星</SelectItem>
            <SelectItem value="3">≥ 3 星</SelectItem>
            <SelectItem value="4">≥ 4 星</SelectItem>
            <SelectItem value="5">5 星</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={`${query.sort_by ?? "date_taken"}:${query.sort_dir ?? "desc"}`}
          onValueChange={(v) => {
            const [sb, sd] = v.split(":");
            setQuery({ sort_by: sb as any, sort_dir: sd as any });
          }}
        >
          <SelectTrigger className="h-8 w-28 text-xs whitespace-nowrap overflow-hidden [&>span]:truncate">
            <SelectValue placeholder="排序" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="date_taken:desc">拍摄时间 ↓</SelectItem>
            <SelectItem value="date_taken:asc">拍摄时间 ↑</SelectItem>
            <SelectItem value="file_name:asc">文件名 A→Z</SelectItem>
            <SelectItem value="iso:desc">ISO ↓</SelectItem>
            <SelectItem value="star_rating:desc">星级 ↓</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 相册 */}
      <div className="flex items-center gap-2 pr-4 border-r border-zinc-800/60">
        <Select
          value={query.album_id != null ? String(query.album_id) : "_all"}
          onValueChange={(v) => setQuery({ album_id: v === "_all" ? null : Number(v) })}
        >
          <SelectTrigger className="h-8 w-28 text-xs whitespace-nowrap overflow-hidden [&>span]:truncate">
            <SelectValue placeholder="相册" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">全部资产</SelectItem>
            {albums.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="icon" variant="ghost" className="h-8 w-8 flex-shrink-0" onClick={() => setNewAlbumOpen(true)} title="新建相册">
          <Plus size={14} />
        </Button>
      </div>

      {/* 批量操作与进度 */}
      <div className="ml-auto flex items-center gap-2">
        <Button size="icon" variant="ghost" className="h-8 w-8 flex-shrink-0" onClick={toggleTheme} title="切换主题">
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </Button>
        {progress && (
          <div className="text-xs text-zinc-500 flex items-center gap-2 mr-4 bg-zinc-900/50 px-2 py-1 rounded whitespace-nowrap">
            <span>导出 #{progress.task_id}: {progress.completed + progress.failed}/{progress.total}</span>
            {progress.done && <span className="text-emerald-500">已完成</span>}
            {progress.last_error && <span className="text-red-400">有报错</span>}
          </div>
        )}
        
        <span className="text-xs text-zinc-500 mr-2 whitespace-nowrap">已选 {ids.length} 项</span>
        <Button size="icon" variant="outline" className="h-8 w-8 flex-shrink-0" disabled={ids.length === 0} onClick={() => setRenameOpen(true)} title="批量重命名">
          <Pencil size={14} />
        </Button>
        <Button size="icon" variant="outline" className="h-8 w-8 flex-shrink-0" disabled={ids.length === 0} onClick={() => setMoveOpen(true)} title="加入相册">
          <FolderPlus size={14} />
        </Button>
        <Button size="icon" variant="destructive" className="h-8 w-8 flex-shrink-0" disabled={ids.length === 0} onClick={() => setDeleteOpen(true)} title="删除">
          <Trash2 size={14} />
        </Button>
      </div>

      <Dialog open={newAlbumOpen} onOpenChange={setNewAlbumOpen}>
        <DialogContent>
          <DialogTitle>新建相册</DialogTitle>
          <Input
            className="mt-3"
            placeholder="相册名称"
            value={newAlbum}
            onChange={(e) => setNewAlbum(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createAlbum(); }}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewAlbumOpen(false)}>取消</Button>
            <Button onClick={createAlbum}>创建</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogTitle>批量重命名</DialogTitle>
          <DialogDescription>
            支持占位符：{"{date} {time} {camera} {name} {index}"}
          </DialogDescription>
          <Input
            className="mt-3"
            value={renameTemplate}
            onChange={(e) => setRenameTemplate(e.target.value)}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>取消</Button>
            <Button onClick={doRename}>确定</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogTitle>加入相册</DialogTitle>
          <DialogDescription>
            把当前选中的 {ids.length} 张资产加入指定相册（虚拟分组，不会移动物理文件）。
          </DialogDescription>
          <div className="mt-3">
            {albums.length === 0 ? (
              <p className="text-xs text-zinc-500">
                还没有相册。请先点顶部的"新建相册"按钮创建一个。
              </p>
            ) : (
              <Select value={moveTargetAlbum} onValueChange={setMoveTargetAlbum}>
                <SelectTrigger>
                  <SelectValue placeholder="选择目标相册" />
                </SelectTrigger>
                <SelectContent>
                  {albums.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMoveOpen(false)}>取消</Button>
            <Button onClick={doMove} disabled={!moveTargetAlbum || albums.length === 0}>
              加入
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogTitle>删除 {ids.length} 张资产</DialogTitle>
          <DialogDescription>
            "仅移除记录"不会动原文件；"移至回收站"会把原文件送进系统回收站。
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>取消</Button>
            <Button variant="secondary" onClick={() => doDelete(false)}>仅移除记录</Button>
            <Button variant="destructive" onClick={() => doDelete(true)}>
              移至回收站
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

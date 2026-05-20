import { useMemo, useRef, useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, FileImage, ImageIcon, Pencil, FolderPlus, Trash2, ChevronLeft, FolderOpen, Files, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import { StarRating } from "./StarRating";
import { api } from "@/api";
import type { Asset } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const PAGE_SIZE = 60;
const COLS = 2;
const ROW_HEIGHT = 220;

export function AssetGrid() {
  const { t } = useTranslation();
  const assets = useStore((s) => s.assets);
  const loading = useStore((s) => s.loading);
  const totalCount = useStore((s) => s.totalCount);
  const loadPage = useStore((s) => s.loadPage);
  const selectedIds = useStore((s) => s.selectedIds);
  const focusedId = useStore((s) => s.focusedId);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const selectRange = useStore((s) => s.selectRange);
  const focusAsset = useStore((s) => s.focusAsset);
  const refreshAssets = useStore((s) => s.refreshAssets);
  const selectAll = useStore((s) => s.selectAll);
  const clearSelection = useStore((s) => s.clearSelection);
  const query = useStore((s) => s.query);
  const albums = useStore((s) => s.albums);
  const currentFolderName = useStore((s) => s.currentFolderName);
  const exitFolder = useStore((s) => s.exitFolder);
  const importing = useStore((s) => s.importing);
  const setImporting = useStore((s) => s.setImporting);
  const refreshFacets = useStore((s) => s.refreshFacets);

  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTargetAlbum, setMoveTargetAlbum] = useState<string>("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const ids = useMemo(() => Array.from(selectedIds), [selectedIds]);

  async function doMove() {
    const albumId = Number(moveTargetAlbum);
    if (!albumId || ids.length === 0) return;
    await api.albumAdd(albumId, ids);
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

  async function pickAndImport() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") return;
    setImporting(true);
    try {
      const report = await api.importDirectory(selected, query.album_id ?? null);
      setImporting(false, { inserted: report.inserted, scanned: report.scanned });
      await Promise.all([refreshAssets(), refreshFacets()]);
    } catch {
      setImporting(false);
    }
  }

  async function pickFilesAndImport() {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "Images", extensions: ["jpg","jpeg","png","tif","tiff","webp","heic","heif","arw","cr2","cr3","nef","nrw","raf","rw2","dng","orf","pef","srw","rwl","sr2"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    setImporting(true);
    try {
      const report = await api.importFiles(paths, query.album_id ?? null);
      setImporting(false, { inserted: report.inserted, scanned: report.scanned });
      await Promise.all([refreshAssets(), refreshFacets()]);
    } catch {
      setImporting(false);
    }
  }

  const loadedCount = assets.filter((a) => a !== undefined).length;
  const allSelected = selectedIds.size > 0 && selectedIds.size === loadedCount;
  const partiallySelected = selectedIds.size > 0 && !allSelected;

  return (
    <div className="flex-1 flex flex-col bg-transparent min-h-0">
      {/* 文件夹 header：返回箭头 + 文件夹名 + 导入按钮 */}
      <div className="border-b border-zinc-800/60 px-3 py-2 flex items-center gap-2">
        <button
          onClick={() => exitFolder()}
          className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
        >
          <ChevronLeft size={14} />
          <span className="truncate max-w-[160px]">{currentFolderName}</span>
        </button>
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button disabled={importing} size="sm" variant="default" className="h-7 text-xs pr-2">
                <FolderOpen size={13} className="mr-1" />
                {importing ? t("sidebar.importing") : t("sidebar.import")}
                <ChevronDown size={11} className="ml-1 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={pickAndImport}>
                <FolderOpen size={13} />
                {t("sidebar.importDir")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={pickFilesAndImport}>
                <Files size={13} />
                {t("sidebar.importFiles")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="border-b border-zinc-800/60 px-4 py-2 flex items-center gap-2 text-xs text-zinc-400 bg-zinc-950/40">
        <button
          onClick={() => (allSelected ? clearSelection() : selectAll())}
          className={cn(
            "flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-zinc-800/60",
            (allSelected || partiallySelected) && "text-primary",
          )}
          title={allSelected ? t("assetGrid.deselectAll") : t("assetGrid.selectAll")}
        >
          <span
            className={cn(
              "w-3.5 h-3.5 rounded-sm border flex items-center justify-center flex-shrink-0",
              allSelected
                ? "bg-primary border-primary"
                : partiallySelected
                  ? "bg-primary/40 border-primary"
                  : "border-zinc-600",
            )}
          >
            {allSelected && <Check size={10} className="text-primary-foreground" strokeWidth={3} />}
            {partiallySelected && <span className="w-1.5 h-0.5 bg-white rounded" />}
          </span>
          {allSelected
            ? t("assetGrid.deselectAll")
            : partiallySelected
              ? t("assetGrid.selected", { count: selectedIds.size })
              : t("assetGrid.selectAllShort")}
        </button>
        <span className="text-zinc-500 ml-1">
          {selectedIds.size > 0
            ? `${t("assetGrid.selected", { count: selectedIds.size })} / ${t("assetGrid.total", { count: totalCount })}`
            : t("assetGrid.total", { count: totalCount })}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <Button size="icon" variant="outline" className="h-7 w-7 flex-shrink-0" disabled={ids.length === 0} onClick={() => setMoveOpen(true)} title={t("assetGrid.addToAlbum")}>
            <FolderPlus size={14} />
          </Button>
          <Button size="icon" variant="destructive" className="h-7 w-7 flex-shrink-0" disabled={ids.length === 0} onClick={() => setDeleteOpen(true)} title={t("assetGrid.delete")}>
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
      {loading && totalCount === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[#4A4F5A] text-xs">
          <div className="w-5 h-5 rounded-full border-2 border-indigo-500/30 border-t-indigo-400 animate-spin" />
          <span>{t("assetGrid.loading")}</span>
        </div>
      )}
      {!loading && totalCount === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center text-[#4A4F5A] text-xs gap-3 p-8">
          <ImageIcon size={40} className="text-[#1a1a24]" />
          <div>{t("assetGrid.empty")}</div>
        </div>
      )}
      {totalCount > 0 && <Grid
        assets={assets}
        totalCount={totalCount}
        loadPage={loadPage}
        selectedIds={selectedIds}
        focusedId={focusedId}
        onSelect={(asset: Asset, e: React.MouseEvent) => {
          if (e.shiftKey) selectRange(asset.id);
          else toggleSelect(asset.id, e.metaKey || e.ctrlKey);
        }}
        onFocus={(asset: Asset) => focusAsset(asset.id)}
        onToggleCheckbox={(asset: Asset) => toggleSelect(asset.id, true)}
        onRatingChange={async (asset: Asset, v: number) => {
          await api.setRating(asset.id, v);
          await refreshAssets();
        }}
        onRenamed={refreshAssets}
      />}

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogTitle>{t("assetGrid.addToAlbum")}</DialogTitle>
          <DialogDescription>
            {t("assetGrid.addToAlbumDesc", { count: ids.length })}
          </DialogDescription>
          <div className="mt-3">
            {albums.length === 0 ? (
              <p className="text-xs text-zinc-500">
                {t("assetGrid.noAlbums")}
              </p>
            ) : (
              <Select value={moveTargetAlbum} onValueChange={setMoveTargetAlbum}>
                <SelectTrigger>
                  <SelectValue placeholder={t("assetGrid.albumPlaceholder")} />
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
            <Button variant="ghost" onClick={() => setMoveOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={doMove} disabled={!moveTargetAlbum || albums.length === 0}>
              {t("assetGrid.add")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogTitle>{t("assetGrid.deleteTitle", { count: ids.length })}</DialogTitle>
          <DialogDescription>
            {t("assetGrid.deleteDesc")}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="secondary" onClick={() => doDelete(false)}>{t("assetGrid.removeRecord")}</Button>
            <Button variant="destructive" onClick={() => doDelete(true)}>
              {t("assetGrid.moveToTrash")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Grid({
  assets,
  totalCount,
  loadPage,
  selectedIds,
  focusedId,
  onSelect,
  onFocus,
  onToggleCheckbox,
  onRatingChange,
  onRenamed,
}: {
  assets: (Asset | undefined)[];
  totalCount: number;
  loadPage: (offset: number) => void;
  selectedIds: Set<number>;
  focusedId: number | null;
  onSelect: (a: Asset, e: React.MouseEvent) => void;
  onFocus: (a: Asset) => void;
  onToggleCheckbox: (a: Asset) => void;
  onRatingChange: (a: Asset, v: number) => void;
  onRenamed: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowCount = Math.ceil(totalCount / COLS);

  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const loadPageRef = useRef(loadPage);
  loadPageRef.current = loadPage;
  const totalCountRef = useRef(totalCount);
  totalCountRef.current = totalCount;

  const checkAndLoad = useRef(() => {
    const vItems = virtualizerRef.current?.getVirtualItems() ?? [];
    const needed = new Set<number>();
    for (const vRow of vItems) {
      for (let col = 0; col < COLS; col++) {
        const idx = vRow.index * COLS + col;
        if (idx < totalCountRef.current && assetsRef.current[idx] === undefined) {
          needed.add(Math.floor(idx / PAGE_SIZE) * PAGE_SIZE);
        }
      }
    }
    needed.forEach((offset) => loadPageRef.current(offset));
  });

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 3,
    onChange: () => queueMicrotask(() => checkAndLoad.current()),
  });

  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  useEffect(() => {
    checkAndLoad.current();
  }, [totalCount, rowCount]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => checkAndLoad.current();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto min-h-0">
      <div
        style={{ height: virtualizer.getTotalSize() + 32, position: "relative" }}
        className="px-4"
      >
        {virtualItems.map((vRow) => (
          <div
            key={vRow.key}
            style={{
              position: "absolute",
              top: vRow.start + 16,
              left: 16,
              right: 16,
              height: vRow.size - 12,
            }}
            className="flex gap-3"
          >
            {Array.from({ length: COLS }).map((_, col) => {
              const idx = vRow.index * COLS + col;
              if (idx >= totalCount) return <div key={col} className="flex-1" />;
              const asset = assets[idx];
              if (!asset) {
                return (
                  <div
                    key={col}
                    style={{ height: ROW_HEIGHT - 12 }}
                    className="flex-1 rounded-md bg-zinc-900/50 border border-zinc-800/80 animate-pulse"
                  />
                );
              }
              return (
                <div key={asset.id} className="flex-1 min-w-0">
                  <Thumb
                    asset={asset}
                    selected={selectedIds.has(asset.id)}
                    focused={focusedId === asset.id}
                    onClick={(e) => {
                      onSelect(asset, e);
                      onFocus(asset);
                    }}
                    onToggleCheckbox={() => onToggleCheckbox(asset)}
                    onRatingChange={(v) => onRatingChange(asset, v)}
                    onRenamed={onRenamed}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Thumb({
  asset,
  selected,
  focused,
  onClick,
  onToggleCheckbox,
  onRatingChange,
  onRenamed,
}: {
  asset: Asset;
  selected: boolean;
  focused: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggleCheckbox: () => void;
  onRatingChange: (v: number) => void;
  onRenamed: () => void;
}) {
  const { t } = useTranslation();
  const [renameOpen, setRenameOpen] = useState(false);
  const [editName, setEditName] = useState("");

  const src = useMemo(() => {
    if (!asset.is_raw) {
      try { return convertFileSrc(asset.file_path); } catch { return null; }
    }
    if (asset.cover_path) {
      try { return convertFileSrc(asset.cover_path); } catch { return null; }
    }
    return null;
  }, [asset.file_path, asset.is_raw, asset.id, asset.cover_path]);

  function openRename(e: React.MouseEvent) {
    e.stopPropagation();
    setEditName(asset.file_name);
    setRenameOpen(true);
  }

  async function commitRename() {
    const name = editName.trim();
    if (!name || name === asset.file_name) {
      setRenameOpen(false);
      return;
    }
    try {
      await api.renameAsset(asset.id, name);
      setRenameOpen(false);
      onRenamed();
    } catch (e) {
      const { toast } = await import("@/hooks/useToast");
      toast.error(t("assetGrid.renameFailed"), { description: String(e) });
    }
  }

  return (
    <>
      <div
        onClick={onClick}
        className={cn(
          "group relative rounded-md overflow-hidden bg-zinc-900/50 border cursor-pointer transition-all hover:border-zinc-700",
          focused ? "border-zinc-400 bg-zinc-800" : "border-zinc-800/80",
          selected && "ring-2 ring-primary ring-offset-1 ring-offset-zinc-950",
        )}
      >
        <div className="relative aspect-square flex items-center justify-center bg-zinc-950 overflow-hidden">
          {src ? (
            <>
              <img
                src={src}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 w-full h-full object-cover opacity-40 blur-xl scale-125"
              />
              <img
                src={src}
                alt={asset.file_name}
                loading="lazy"
                className="relative z-10 w-full h-full object-contain no-drag"
              />
            </>
          ) : (
            <div className="relative z-10 flex flex-col items-center text-zinc-500 text-xs gap-1">
              <FileImage size={28} />
              {asset.file_type || "RAW"}
            </div>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleCheckbox(); }}
            className={cn(
              "absolute z-20 top-1.5 right-1.5 w-5 h-5 rounded border-2 flex items-center justify-center transition-opacity",
              selected
                ? "bg-primary border-primary opacity-100"
                : "bg-zinc-950/60 border-zinc-300 opacity-0 group-hover:opacity-100",
            )}
            title={selected ? t("assetGrid.deselect") : t("assetGrid.select")}
          >
            {selected && <Check size={12} className="text-primary-foreground" strokeWidth={3} />}
          </button>
          <span className="absolute z-20 top-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-zinc-950/60 text-zinc-200 border border-zinc-50/10 backdrop-blur-sm">
            {asset.file_type ?? "?"}
          </span>
        </div>
        <div className="p-2.5 flex flex-col gap-2">
          <p className="text-xs text-zinc-200 truncate leading-none" title={asset.file_name}>{asset.file_name}</p>
          <div className="flex items-center justify-between mt-0.5">
            <StarRating value={asset.star_rating} onChange={onRatingChange} size={12} />
            <button
              type="button"
              onClick={openRename}
              className="shrink-0 text-zinc-600 hover:text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity"
              title={t("assetGrid.rename")}
            >
              <Pencil size={11} />
            </button>
          </div>
        </div>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogTitle>{t("assetGrid.rename")}</DialogTitle>
          <DialogDescription>{asset.file_name}</DialogDescription>
          <Input
            className="mt-3"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitRename(); }}
            autoFocus
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={commitRename} disabled={!editName.trim()}>{t("common.confirm")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ImageIcon,
  Plus,
  Star,
  RotateCcw,
  FolderOpen,
  Files,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "@/store";
import { api } from "@/api";
import { orientationCss } from "@/lib/orientation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { Asset, AssetQuery } from "@/types";
import {
  ThumbContextMenu,
  ConfirmDeleteDialog,
  type ThumbMenuState,
  type ConfirmState,
} from "./AssetStripContextMenu";
import { FilterMenu, SortMenu } from "./AssetStripFilters";

const THUMB_W = 80;
const GAP = 8;
const SLOT = THUMB_W + GAP;
const PAGE = 60;
type ThumbImage = {
  orientation?: number | null;
  src: string;
};
const rawThumbCache = new Map<number, ThumbImage>();

const IMAGE_EXT = [
  "jpg", "jpeg", "png", "tif", "tiff", "webp", "heic", "heif",
  "arw", "cr2", "cr3", "nef", "nrw", "raf", "rw2", "dng",
  "orf", "pef", "srw", "rwl", "sr2",
];

export function AssetStrip() {
  const { t } = useTranslation();
  const assets = useStore((s) => s.assets);
  const selectedIds = useStore((s) => s.selectedIds);
  const focusedId = useStore((s) => s.focusedId);
  const totalCount = useStore((s) => s.totalCount);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const importing = useStore((s) => s.importing);
  const setImporting = useStore((s) => s.setImporting);
  const refreshAssets = useStore((s) => s.refreshAssets);
  const refreshFacets = useStore((s) => s.refreshFacets);
  const refreshProjectSummaries = useStore((s) => s.refreshProjectSummaries);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const selectRange = useStore((s) => s.selectRange);
  const focusAsset = useStore((s) => s.focusAsset);
  const loadPage = useStore((s) => s.loadPage);
  const patchAsset = useStore((s) => s.patchAsset);

  const scrollerRef = useRef<HTMLDivElement>(null);

  const focused = useMemo(
    () => assets.find((a) => a?.id === focusedId) ?? null,
    [assets, focusedId],
  );

  const [menu, setMenu] = useState<ThumbMenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  function handleContextMenu(asset: Asset, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // 右键到未选中的缩图：把它单独定为操作目标；右键到已选中的多张里任意一张：保持多选
    const isMulti = selectedIds.size > 1 && selectedIds.has(asset.id);
    if (!isMulti && !selectedIds.has(asset.id)) {
      toggleSelect(asset.id, false);
      focusAsset(asset.id);
    }
    // 视口外溢出时夹一下，避免被边缘裁掉
    const MARGIN = 8;
    const x = Math.min(e.clientX, window.innerWidth - 200 - MARGIN);
    const y = Math.min(e.clientY, window.innerHeight - 180 - MARGIN);
    setMenu({ x, y, assetId: asset.id, multi: isMulti });
  }

  function requestDelete(kind: "db" | "disk", multi: boolean) {
    if (!menu) return;
    const ids = multi
      ? Array.from(selectedIds)
      : [menu.assetId];
    if (ids.length === 0) return;
    setConfirm({ kind, ids });
  }

  async function performDelete() {
    if (!confirm) return;
    const { ids, kind } = confirm;
    setConfirm(null);
    try {
      // kind=db: 仅删除表中数据，不动磁盘文件；kind=disk: 文件入回收站 + 删除记录
      await api.deleteAssets(ids, kind === "disk");
      await Promise.all([refreshAssets(), refreshFacets(), refreshProjectSummaries()]);
    } catch (e) {
      console.error("[AssetStrip] delete failed:", e);
    }
  }

  async function revealCurrent() {
    if (!menu) return;
    const a = assets.find((x) => x?.id === menu.assetId);
    if (!a) return;
    try {
      await api.revealInFinder(a.file_path);
    } catch (e) {
      console.error("[AssetStrip] reveal failed:", e);
    }
  }

  const hasFilter =
    !!query.search ||
    (query.min_rating ?? 0) > 0;

  const count = totalCount;

  const virtualizer = useVirtualizer({
    horizontal: true,
    count,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => SLOT,
    overscan: 8,
  });

  const virtualItems = virtualizer.getVirtualItems();

  const pendingPages = useMemo(() => {
    const set = new Set<number>();
    for (const v of virtualItems) {
      if (assets[v.index] === undefined) {
        set.add(Math.floor(v.index / PAGE) * PAGE);
      }
    }
    return set;
  }, [virtualItems, assets]);

  useEffect(() => {
    pendingPages.forEach((offset) => {
      loadPage(offset);
    });
  }, [pendingPages, loadPage]);

  function handleClick(asset: Asset, e: React.MouseEvent) {
    if (e.shiftKey) selectRange(asset.id);
    else toggleSelect(asset.id, e.metaKey || e.ctrlKey);
    focusAsset(asset.id);
  }

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  async function pickAndImport() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") return;
    setImporting(true);
    try {
      const report = await api.importDirectory(selected, query.project_id ?? null);
      setImporting(false, { inserted: report.inserted, scanned: report.scanned });
      await Promise.all([refreshAssets(), refreshFacets(), refreshProjectSummaries()]);
    } catch {
      setImporting(false);
    }
  }

  async function pickFilesAndImport() {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "Images", extensions: IMAGE_EXT }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    setImporting(true);
    try {
      const report = await api.importFiles(paths, query.project_id ?? null);
      setImporting(false, { inserted: report.inserted, scanned: report.scanned });
      await Promise.all([refreshAssets(), refreshFacets(), refreshProjectSummaries()]);
    } catch {
      setImporting(false);
    }
  }

  async function rateFocused(rating: number) {
    if (!focused) return;
    const next = focused.star_rating === rating ? 0 : rating;
    await api.setRating(focused.id, next).catch(() => {});
    patchAsset({ ...focused, star_rating: next });
  }

  return (
    <div className="h-[160px] flex-shrink-0 flex flex-col border-t border-zinc-800/60 bg-zinc-950/50 overflow-hidden">
      <div className="h-9 flex-shrink-0 flex items-center gap-1 px-3 text-xs text-zinc-400 border-b border-zinc-800/60">
        {/* 导入 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={importing}
              className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-zinc-800/60 text-zinc-300 disabled:opacity-50"
              title={t("sidebar.import")}
            >
              <Plus size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
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

        {/* 筛选（关键词 + 星级） */}
        <FilterMenu
          hasFilter={hasFilter}
          search={query.search ?? ""}
          minRating={query.min_rating ?? 0}
          onChange={(patch) => setQuery(patch)}
        />

        {/* 排序 */}
        <SortMenu
          sortBy={query.sort_by ?? "date_taken"}
          sortDir={query.sort_dir ?? "desc"}
          onChange={(patch) => setQuery(patch)}
        />

        {/* 重置筛选 + 排序 */}
        <button
          type="button"
          onClick={() =>
            setQuery({
              search: null,
              min_rating: null,
              camera_model: null,
              sort_by: "date_taken",
              sort_dir: "desc",
            })
          }
          className="h-7 w-7 inline-flex items-center justify-center rounded text-zinc-400 hover:bg-zinc-800/60"
          title={t("sidebar.resetFilters")}
        >
          <RotateCcw size={12} />
        </button>

        {/* 中间：评星（针对 focused 素材） */}
        <div className="flex-1 min-w-0 flex items-center justify-center">
          <div
            className="flex items-center gap-0.5"
            title={t("editor.strip.ratingFor")}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                disabled={!focused}
                onClick={() => rateFocused(n)}
                className="p-0.5 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-600 hover:text-amber-300"
              >
                <Star
                  size={13}
                  className={cn(
                    "transition-colors",
                    focused && n <= focused.star_rating
                      ? "text-amber-400 fill-amber-400"
                      : "fill-none",
                  )}
                />
              </button>
            ))}
          </div>
        </div>

        {/* 右侧：选中计数 */}
        <span className="flex-shrink-0 text-[11px] text-zinc-400">
          {t("editor.strip.selectedCountOfTotal", { n: selectedIds.size, m: totalCount })}
        </span>
      </div>

      <div ref={scrollerRef} className="flex-1 overflow-x-auto overflow-y-hidden">
        {totalCount === 0 ? (
          <div className="h-full flex items-center justify-center text-zinc-500 text-xs">
            {t("editor.emptyFolder")}
          </div>
        ) : (
          <div
            className="relative h-full"
            style={{ width: virtualizer.getTotalSize() + 16 }}
          >
            {virtualItems.map((v) => {
              const a = assets[v.index];
              const left = v.start + 8;
              return (
                <div
                  key={v.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left,
                    width: THUMB_W,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  {a ? (
                    <Thumb
                      asset={a}
                      selected={selectedIds.has(a.id)}
                      focused={focusedId === a.id}
                      onClick={(e) => handleClick(a, e)}
                      onContextMenu={(e) => handleContextMenu(a, e)}
                    />
                  ) : (
                    <div className="w-20 h-20 rounded-md bg-zinc-900/60 animate-pulse" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ThumbContextMenu
        state={menu}
        onClose={() => setMenu(null)}
        onRequestDelete={requestDelete}
        onReveal={revealCurrent}
      />
      <ConfirmDeleteDialog
        state={confirm}
        onCancel={() => setConfirm(null)}
        onConfirm={performDelete}
      />
    </div>
  );
}



function Thumb({
  asset,
  selected,
  focused,
  onClick,
  onContextMenu,
}: {
  asset: Asset;
  selected: boolean;
  focused: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const image = useThumbImage(asset);
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        "w-20 h-20 flex-shrink-0 rounded-md overflow-hidden border-2 bg-zinc-900 transition-colors",
        focused
          ? "border-blue-500"
          : selected
            ? "border-blue-500/60"
            : "border-transparent hover:border-zinc-600",
      )}
      title={asset.file_name}
    >
      {image ? (
        <img
          src={image.src}
          className="w-full h-full object-cover"
          style={orientationCss(image.orientation)}
          alt=""
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-zinc-700">
          <ImageIcon size={20} />
        </div>
      )}
    </button>
  );
}

function useThumbImage(asset: Asset) {
  const [image, setImage] = useState<ThumbImage | null>(() => {
    if (asset.is_raw) return rawThumbCache.get(asset.id) ?? null;
    try {
      return { src: convertFileSrc(asset.file_path) };
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let cancelled = false;
    if (!asset.is_raw) {
      try {
        setImage({ src: convertFileSrc(asset.file_path) });
      } catch {
        setImage(null);
      }
      return;
    }

    const cached = rawThumbCache.get(asset.id);
    if (cached) {
      setImage(cached);
      return;
    }

    setImage(null);
    api.getAssetThumbnail(asset.id)
      .then((result) => {
        if (cancelled) return;
        if (result.data?.length) {
          const blob = new Blob([new Uint8Array(result.data)], {
            type: result.mimeType ?? "image/jpeg",
          });
          const url = URL.createObjectURL(blob);
          const next = { src: url, orientation: result.orientation ?? null };
          rawThumbCache.set(asset.id, next);
          setImage(next);
          return;
        }
        if (result.path) {
          const url = convertFileSrc(result.path);
          const next = { src: url, orientation: result.orientation ?? null };
          rawThumbCache.set(asset.id, next);
          setImage(next);
        }
      })
      .catch(() => {
        if (!cancelled) setImage(null);
      });

    return () => {
      cancelled = true;
    };
  }, [asset.file_path, asset.id, asset.is_raw]);

  return image;
}

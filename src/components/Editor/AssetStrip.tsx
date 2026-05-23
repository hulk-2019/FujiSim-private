import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ImageIcon,
  Plus,
  Filter,
  ArrowUpDown,
  Star,
  RotateCcw,
  FolderOpen,
  Files,
  Check,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "@/store";
import { api } from "@/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { Asset, AssetQuery } from "@/types";

const THUMB_W = 80;
const GAP = 8;
const SLOT = THUMB_W + GAP;
const PAGE = 60;

const IMAGE_EXT = [
  "jpg", "jpeg", "png", "tif", "tiff", "webp", "heic", "heif",
  "arw", "cr2", "cr3", "nef", "nrw", "raf", "rw2", "dng",
  "orf", "pef", "srw", "rwl", "sr2",
];

const SORT_FIELDS: NonNullable<AssetQuery["sort_by"]>[] = [
  "date_taken",
  "created_at",
  "star_rating",
  "file_name",
  "iso",
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
  const refreshAlbumSummaries = useStore((s) => s.refreshAlbumSummaries);
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
      const report = await api.importDirectory(selected, query.album_id ?? null);
      setImporting(false, { inserted: report.inserted, scanned: report.scanned });
      await Promise.all([refreshAssets(), refreshFacets(), refreshAlbumSummaries()]);
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
      const report = await api.importFiles(paths, query.album_id ?? null);
      setImporting(false, { inserted: report.inserted, scanned: report.scanned });
      await Promise.all([refreshAssets(), refreshFacets(), refreshAlbumSummaries()]);
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
    </div>
  );
}

function FilterMenu({
  hasFilter,
  search,
  minRating,
  onChange,
}: {
  hasFilter: boolean;
  search: string;
  minRating: number;
  onChange: (patch: AssetQuery) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(search);

  useEffect(() => {
    if (open) setText(search);
  }, [open, search]);

  function commitSearch() {
    onChange({ search: text.trim() || null });
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "h-7 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-zinc-800/60",
            hasFilter ? "text-amber-300" : "text-zinc-400",
          )}
          title={t("editor.strip.filterTitle")}
        >
          <Filter size={12} />
          {hasFilter ? t("editor.strip.filterActive") : t("editor.strip.filterEmpty")}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-3 space-y-3">
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">
            {t("editor.strip.keyword")}
          </div>
          <Input
            value={text}
            placeholder={t("editor.strip.keywordPlaceholder")}
            className="h-7 text-[11px]"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitSearch();
                setOpen(false);
              }
            }}
            onBlur={commitSearch}
          />
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">
            {t("editor.strip.rating")}
          </div>
          <div className="flex items-center gap-1">
            {[0, 1, 2, 3, 4, 5].map((n) => {
              const active = minRating === n;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => onChange({ min_rating: n === 0 ? null : n })}
                  className={cn(
                    "h-6 min-w-[28px] px-1.5 rounded text-[11px] border transition-colors",
                    active
                      ? "bg-amber-400/20 border-amber-400/60 text-amber-200"
                      : "border-zinc-800 text-zinc-400 hover:bg-zinc-800/60",
                  )}
                >
                  {n === 0 ? t("sidebar.allRatings") : `≥${n}`}
                </button>
              );
            })}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortMenu({
  sortBy,
  sortDir,
  onChange,
}: {
  sortBy: NonNullable<AssetQuery["sort_by"]>;
  sortDir: NonNullable<AssetQuery["sort_dir"]>;
  onChange: (patch: AssetQuery) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="h-7 px-2 inline-flex items-center gap-1 rounded text-[11px] text-zinc-400 hover:bg-zinc-800/60"
          title={t("editor.strip.sortField")}
        >
          <ArrowUpDown size={12} />
          {t(`editor.strip.sortFields.${sortBy}` as any, { defaultValue: sortBy })}
          <span className="text-zinc-500">{sortDir === "asc" ? "↑" : "↓"}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52 p-1">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500">
          {t("editor.strip.sortField")}
        </div>
        {SORT_FIELDS.map((f) => {
          const active = sortBy === f;
          return (
            <DropdownMenuItem
              key={f}
              onSelect={(e) => {
                e.preventDefault();
                onChange({ sort_by: f });
              }}
              className="text-[11px] justify-between"
            >
              <span>{t(`editor.strip.sortFields.${f}` as any, { defaultValue: f })}</span>
              {active && <Check size={12} className="text-amber-300" />}
            </DropdownMenuItem>
          );
        })}
        <div className="my-1 h-px bg-zinc-800" />
        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500">
          {t("editor.strip.sortDir")}
        </div>
        {(["desc", "asc"] as const).map((d) => {
          const active = sortDir === d;
          return (
            <DropdownMenuItem
              key={d}
              onSelect={(e) => {
                e.preventDefault();
                onChange({ sort_dir: d });
              }}
              className="text-[11px] justify-between"
            >
              <span>{t(`editor.strip.sortDir${d === "asc" ? "Asc" : "Desc"}` as any)}</span>
              {active && <Check size={12} className="text-amber-300" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Thumb({
  asset,
  selected,
  focused,
  onClick,
}: {
  asset: Asset;
  selected: boolean;
  focused: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const src = (() => {
    try {
      if (!asset.is_raw) return convertFileSrc(asset.file_path);
      if (asset.cover_path) return convertFileSrc(asset.cover_path);
      return null;
    } catch {
      return null;
    }
  })();
  return (
    <button
      type="button"
      onClick={onClick}
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
      {src ? (
        <img src={src} className="w-full h-full object-cover" alt="" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-zinc-700">
          <ImageIcon size={20} />
        </div>
      )}
    </button>
  );
}

import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon } from "lucide-react";
import { useStore } from "@/store";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { Asset } from "@/types";

export function AssetStrip() {
  const { t } = useTranslation();
  const assets = useStore((s) => s.assets);
  const selectedIds = useStore((s) => s.selectedIds);
  const focusedId = useStore((s) => s.focusedId);
  const totalCount = useStore((s) => s.totalCount);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const selectRange = useStore((s) => s.selectRange);
  const focusAsset = useStore((s) => s.focusAsset);

  const scrollerRef = useRef<HTMLDivElement>(null);

  const focused = assets.find((a) => a?.id === focusedId) ?? null;

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

  return (
    <div className="h-[140px] flex-shrink-0 flex flex-col border-t border-zinc-800/60 bg-zinc-950/50 overflow-hidden">
      <div className="h-8 flex-shrink-0 flex items-center gap-3 px-3 text-xs text-zinc-400">
        <Select
          value={String(query.min_rating ?? 0)}
          onValueChange={(v) => setQuery({ min_rating: Number(v) || null })}
        >
          <SelectTrigger className="h-6 w-28 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">{t("sidebar.allRatings")}</SelectItem>
            <SelectItem value="1">{t("sidebar.ratingGte1")}</SelectItem>
            <SelectItem value="2">{t("sidebar.ratingGte2")}</SelectItem>
            <SelectItem value="3">{t("sidebar.ratingGte3")}</SelectItem>
            <SelectItem value="4">{t("sidebar.ratingGte4")}</SelectItem>
            <SelectItem value="5">{t("sidebar.rating5")}</SelectItem>
          </SelectContent>
        </Select>
        <span className="truncate flex-1">{focused?.file_name ?? ""}</span>
        <span className="flex-shrink-0">
          {t("editor.strip.selectedCountOfTotal", { n: selectedIds.size, m: totalCount })}
        </span>
        <Button size="sm" variant="ghost" className="h-6 text-[11px]">
          {t("editor.strip.single")}
        </Button>
        <Button size="sm" variant="ghost" className="h-6 text-[11px]" disabled>
          {t("editor.strip.compare")}
        </Button>
      </div>

      <div ref={scrollerRef} className="flex-1 overflow-x-auto overflow-y-hidden">
        {totalCount === 0 ? (
          <div className="h-full flex items-center justify-center text-zinc-500 text-xs">
            {t("editor.emptyFolder")}
          </div>
        ) : (
          <div className="h-full flex items-center gap-2 px-3">
            {assets.map((a, i) =>
              a ? (
                <Thumb
                  key={a.id}
                  asset={a}
                  selected={selectedIds.has(a.id)}
                  focused={focusedId === a.id}
                  onClick={(e) => handleClick(a, e)}
                />
              ) : (
                <div
                  key={`ph-${i}`}
                  className="w-20 h-20 flex-shrink-0 rounded-md bg-zinc-900/60 animate-pulse"
                />
              ),
            )}
          </div>
        )}
      </div>
    </div>
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
  const src = asset.cover_path ? convertFileSrc(asset.cover_path) : null;
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

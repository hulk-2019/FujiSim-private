import { useEffect, useState } from "react";
import { Filter, ArrowUpDown, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { AssetQuery } from "@/types";

const SORT_FIELDS: NonNullable<AssetQuery["sort_by"]>[] = [
  "date_taken",
  "created_at",
  "star_rating",
  "file_name",
  "iso",
];

export function FilterMenu({
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

export function SortMenu({
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

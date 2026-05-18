import { useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Search, RotateCcw, Sun, Moon, Eraser, Settings, Globe } from "lucide-react";
import { type BatchProgress } from "@/api";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { ExportTasksPopover } from "@/components/ExportTasksPopover";
import { ClearCacheDialog } from "@/components/ClearCacheDialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "react-i18next";

export function Sidebar() {
  const { t } = useTranslation();
  const cameras = useStore((s) => s.cameras);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const selectedIds = useStore((s) => s.selectedIds);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const toggleLanguage = useStore((s) => s.toggleLanguage);

  const [searchText, setSearchText] = useState("");
  const [clearCacheOpen, setClearCacheOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen<BatchProgress>("export:progress", (e) => {
      useStore.getState().setProgress(e.payload);
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
  }, []);

  const ids = useMemo(() => Array.from(selectedIds), [selectedIds]);
  void ids; // retained for future batch ops

  return (
    <aside className="w-full px-4 py-2 bg-transparent flex items-center flex-wrap gap-3 text-sm relative z-10">
      <div className="relative w-64 flex-shrink-0">
        <Search size={14} className="absolute left-2.5 top-2 text-zinc-500" />
        <Input
          placeholder={t("sidebar.searchPlaceholder")}
          className="h-8 pl-8 text-xs"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setQuery({ search: searchText || null });
          }}
        />
      </div>

      <div className="h-4 w-px bg-zinc-800/60 mx-1" />

      <div className="flex items-center gap-2">
        <Select
          value={query.camera_model ?? "_all"}
          onValueChange={(v) => setQuery({ camera_model: v === "_all" ? null : v })}
        >
          <SelectTrigger className="h-8 w-32 text-xs whitespace-nowrap overflow-hidden [&>span]:truncate">
            <SelectValue placeholder={t("sidebar.cameraPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">{t("sidebar.allCameras")}</SelectItem>
            {cameras.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(query.min_rating ?? 0)}
          onValueChange={(v) => setQuery({ min_rating: Number(v) || null })}
        >
          <SelectTrigger className="h-8 w-32 text-xs whitespace-nowrap overflow-hidden [&>span]:truncate">
            <SelectValue placeholder={t("sidebar.ratingPlaceholder")} />
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
        <Select
          value={`${query.sort_by ?? "date_taken"}:${query.sort_dir ?? "desc"}`}
          onValueChange={(v) => {
            const [sb, sd] = v.split(":");
            setQuery({ sort_by: sb as any, sort_dir: sd as any });
          }}
        >
          <SelectTrigger className="h-8 w-32 text-xs whitespace-nowrap overflow-hidden [&>span]:truncate">
            <SelectValue placeholder={t("sidebar.sortPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="date_taken:desc">{t("sidebar.sortDateDesc")}</SelectItem>
            <SelectItem value="date_taken:asc">{t("sidebar.sortDateAsc")}</SelectItem>
            <SelectItem value="file_name:asc">{t("sidebar.sortNameAz")}</SelectItem>
            <SelectItem value="iso:desc">ISO ↓</SelectItem>
            <SelectItem value="star_rating:desc">{t("sidebar.sortRatingDesc")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 flex-shrink-0"
          title={t("sidebar.resetFilters")}
          onClick={() => {
            setSearchText("");
            setQuery({
              camera_model: null,
              min_rating: null,
              sort_by: "date_taken",
              sort_dir: "desc",
              search: null,
            });
          }}
        >
          <RotateCcw size={14} />
        </Button>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ExportTasksPopover />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="h-8 w-8 flex-shrink-0" title={t("sidebar.settings")}>
              <Settings size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={toggleTheme}>
              {theme === "dark" ? <Sun size={14} className="mr-2" /> : <Moon size={14} className="mr-2" />}
              {t("sidebar.toggleTheme")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={toggleLanguage}>
              <Globe size={14} className="mr-2" />
              {t("sidebar.toggleLanguage")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setClearCacheOpen(true)}>
              <Eraser size={14} className="mr-2" />
              {t("sidebar.clearCache")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ClearCacheDialog open={clearCacheOpen} onOpenChange={setClearCacheOpen} />
    </aside>
  );
}

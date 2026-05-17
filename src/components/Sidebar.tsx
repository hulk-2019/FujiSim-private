import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FolderOpen, Plus, Search, RefreshCw, Files, ChevronDown, Sun, Moon, Eraser, Settings, Globe } from "lucide-react";
import { api, type BatchProgress } from "@/api";
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
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";

export function Sidebar() {
  const { t } = useTranslation();
  const importing = useStore((s) => s.importing);
  const cameras = useStore((s) => s.cameras);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const refreshAssets = useStore((s) => s.refreshAssets);
  const refreshFacets = useStore((s) => s.refreshFacets);
  const setImporting = useStore((s) => s.setImporting);
  const selectedIds = useStore((s) => s.selectedIds);
  const setProgress = useStore((s) => s.setProgress);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const toggleLanguage = useStore((s) => s.toggleLanguage);
  const albums = useStore((s) => s.albums);
  const refreshAlbums = useStore((s) => s.refreshAlbums);

  const [newAlbumOpen, setNewAlbumOpen] = useState(false);
  const [newAlbum, setNewAlbum] = useState("");
  const [searchText, setSearchText] = useState("");
  const [clearCacheOpen, setClearCacheOpen] = useState(false);

  useEffect(() => {
    refreshAlbums();
  }, [refreshAlbums]);

  useEffect(() => {
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
  void ids; // retained for future batch ops

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
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "tif", "tiff", "webp", "heic", "heif", "arw", "cr2", "cr3", "nef", "nrw", "raf", "rw2", "dng", "orf", "pef", "srw", "rwl", "sr2"] }],
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
    await refreshAlbums();
  }

  return (
    <aside className="w-full px-4 py-2 bg-transparent flex items-center flex-wrap gap-3 text-sm relative z-10">
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button disabled={importing} size="sm" variant="default" className="h-8 whitespace-nowrap pr-2">
              <FolderOpen size={14} className="mr-1 flex-shrink-0" />
              {importing ? t("sidebar.importing") : t("sidebar.import")}
              <ChevronDown size={12} className="ml-1 opacity-70" />
            </Button>
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
        <Button onClick={() => refreshAssets()} variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" title={t("sidebar.refresh")}>
          <RefreshCw size={14} />
        </Button>
      </div>

      <div className="h-4 w-px bg-zinc-800/60 mx-1" />

      <div className="relative w-40 flex-shrink-0">
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
          <SelectTrigger className="h-8 w-28 text-xs whitespace-nowrap overflow-hidden [&>span]:truncate">
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
          <SelectTrigger className="h-8 w-24 text-xs whitespace-nowrap overflow-hidden [&>span]:truncate">
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
          <SelectTrigger className="h-8 w-28 text-xs whitespace-nowrap overflow-hidden [&>span]:truncate">
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
      </div>

      <div className="h-4 w-px bg-zinc-800/60 mx-1" />

      <div className="flex items-center gap-2">
        <Select
          value={query.album_id != null ? String(query.album_id) : "_all"}
          onValueChange={(v) => setQuery({ album_id: v === "_all" ? null : Number(v) })}
        >
          <SelectTrigger className="h-8 w-28 text-xs whitespace-nowrap overflow-hidden [&>span]:truncate">
            <SelectValue placeholder={t("sidebar.albumPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">{t("sidebar.allAssets")}</SelectItem>
            {albums.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="icon" variant="ghost" className="h-8 w-8 flex-shrink-0" onClick={() => setNewAlbumOpen(true)} title={t("sidebar.newAlbum")}>
          <Plus size={14} />
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

      <Dialog open={newAlbumOpen} onOpenChange={setNewAlbumOpen}>
        <DialogContent>
          <DialogTitle>{t("sidebar.newAlbum")}</DialogTitle>
          <Input
            className="mt-3"
            placeholder={t("sidebar.albumNamePlaceholder")}
            value={newAlbum}
            onChange={(e) => setNewAlbum(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createAlbum(); }}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewAlbumOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={createAlbum}>{t("common.create")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <ClearCacheDialog open={clearCacheOpen} onOpenChange={setClearCacheOpen} />
    </aside>
  );
}

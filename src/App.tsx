import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Sidebar } from "@/components/Sidebar";
import { AssetList } from "@/components/AssetList";
import { FolderList } from "@/components/FolderList";
import { PreviewPanel } from "@/components/PreviewPanel";
import { FilterPanel } from "@/components/FilterPanel";
import { ExportDialog } from "@/components/ExportDialog";
import { Toaster } from "@/components/ui/toast";
import { UpdaterBootstrap } from "@/components/UpdaterBootstrap";
import { useStore } from "@/store";
import { api } from "@/api";

export default function App() {
  const currentFolderId = useStore((s) => s.currentFolderId);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    api.getSetting("ui.theme").then((raw) => {
      if (raw && JSON.parse(raw) === "dark") {
        document.documentElement.classList.add("dark");
      }
    }).catch(() => {});
    api.getSetting("ui.language").then((raw) => {
      if (raw) {
        const lang = JSON.parse(raw);
        if (lang === "en" || lang === "zh") {
          import("@/i18n").then(({ default: i18n }) => i18n.changeLanguage(lang));
        }
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const { refreshAssets, refreshFacets, refreshPresets, refreshUserLuts, refreshAlbums, setCoverDir } = useStore.getState();
    refreshAssets();
    refreshFacets();
    refreshPresets();
    refreshUserLuts();
    refreshAlbums();
    api.getCoverDir().then(setCoverDir).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const pendingIds = new Set<number>();
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    listen<{ asset_id: number }>("thumbnail:done", (e) => {
      if (cancelled) return;
      pendingIds.add(e.payload.asset_id);
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = setTimeout(async () => {
        if (cancelled) return;
        const ids = [...pendingIds];
        pendingIds.clear();
        const updates = await Promise.all(ids.map((id) => api.getAsset(id).catch(() => null)));
        const valid = updates.filter((a): a is NonNullable<typeof a> => a !== null);
        if (valid.length > 0) useStore.getState().batchPatchAssets(valid);
      }, 200);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      if (batchTimer) clearTimeout(batchTimer);
      unlisten?.();
    };
  }, []);

  return (
    <div className="h-full w-full flex flex-col bg-zinc-950 text-zinc-200">
      <div className="flex-shrink-0 border-b border-zinc-800/60 bg-zinc-950/50">
        <Sidebar />
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="w-[360px] flex-shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800/60 overflow-hidden">
          {currentFolderId === null ? <FolderList /> : <AssetList />}
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
      <UpdaterBootstrap />
    </div>
  );
}

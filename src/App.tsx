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

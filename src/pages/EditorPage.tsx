import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { PreviewPanel } from "@/components/PreviewPanel";
import { FilterPanel } from "@/components/FilterPanel";
import { ExportDialog } from "@/components/ExportDialog";
import { PresetList } from "@/components/Editor/PresetList";
import { EditorToolbar } from "@/components/Editor/EditorToolbar";
import { AssetStrip } from "@/components/Editor/AssetStrip";
import { useStore } from "@/store";

export function EditorPage() {
  const { folderId } = useParams<{ folderId: string }>();
  const enterFolder = useStore((s) => s.enterFolder);
  const exitFolder = useStore((s) => s.exitFolder);
  const albums = useStore((s) => s.albums);
  const [exportOpen, setExportOpen] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);

  useEffect(() => {
    if (!folderId) return;
    const id = Number(folderId);
    const album = albums.find((a) => a.id === id);
    const name = album?.name ?? String(id);
    enterFolder(id, name);
    return () => {
      exitFolder();
    };
  }, [folderId]);

  return (
    <div className="flex-1 flex min-h-0 bg-zinc-950 overflow-hidden">
      <PresetList />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <EditorToolbar
          showOriginal={showOriginal}
          onToggleShowOriginal={() => setShowOriginal((v) => !v)}
          onExport={() => setExportOpen(true)}
        />
        <div className="flex-1 min-h-0 overflow-hidden">
          <PreviewPanel
            showOriginal={showOriginal}
            onShowOriginalChange={setShowOriginal}
          />
        </div>
        <AssetStrip />
      </div>

      <div className="w-[340px] flex-shrink-0 flex flex-col bg-zinc-950/50 border-l border-zinc-800/60 overflow-hidden">
        <FilterPanel />
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
    </div>
  );
}

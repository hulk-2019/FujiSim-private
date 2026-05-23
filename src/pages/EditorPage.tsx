import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { AssetList } from "@/components/AssetList";
import { PreviewPanel } from "@/components/PreviewPanel";
import { FilterPanel } from "@/components/FilterPanel";
import { ExportDialog } from "@/components/ExportDialog";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";

export function EditorPage() {
  const { folderId } = useParams<{ folderId: string }>();
  const navigate = useNavigate();
  const enterFolder = useStore((s) => s.enterFolder);
  const exitFolder = useStore((s) => s.exitFolder);
  const albums = useStore((s) => s.albums);
  const [exportOpen, setExportOpen] = useState(false);

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
    <div className="flex-1 flex flex-col min-h-0 bg-zinc-950">
      <div className="flex-shrink-0 border-b border-zinc-800/60 bg-zinc-950/50 flex items-center">
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 ml-2 flex-shrink-0"
          onClick={() => navigate("/projects")}
        >
          <ArrowLeft size={15} />
        </Button>
        <div className="flex-1">
          <Sidebar />
        </div>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="w-[360px] flex-shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800/60 overflow-hidden">
          <AssetList />
        </div>
        <div className="flex-1 flex flex-col min-w-0 bg-zinc-950">
          <PreviewPanel onExport={() => setExportOpen(true)} />
        </div>
        <div className="w-[320px] flex-shrink-0 flex flex-col bg-zinc-950/50 border-l border-zinc-800/60 overflow-hidden">
          <FilterPanel />
        </div>
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
    </div>
  );
}

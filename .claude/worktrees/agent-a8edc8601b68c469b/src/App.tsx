import { useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { AssetGrid } from "@/components/AssetGrid";
import { PreviewPanel } from "@/components/PreviewPanel";
import { FilterPanel } from "@/components/FilterPanel";
import { ExportDialog } from "@/components/ExportDialog";
import { useStore } from "@/store";

export default function App() {
  const refreshAssets = useStore((s) => s.refreshAssets);
  const refreshFacets = useStore((s) => s.refreshFacets);
  const refreshPresets = useStore((s) => s.refreshPresets);
  const refreshUserLuts = useStore((s) => s.refreshUserLuts);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    refreshAssets();
    refreshFacets();
    refreshPresets();
    refreshUserLuts();
  }, [refreshAssets, refreshFacets, refreshPresets, refreshUserLuts]);

  return (
    <div className="h-full w-full flex flex-col bg-zinc-950 text-zinc-200">
      {/* 顶部操作区 */}
      <div className="flex-shrink-0 border-b border-zinc-800/60 bg-zinc-950/50">
        <Sidebar />
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* 文件列表 */}
        <div className="w-[360px] flex-shrink-0 flex flex-col bg-zinc-950 border-r border-zinc-800/60 overflow-hidden">
          <AssetGrid />
        </div>
        
        {/* 画布 */}
        <div className="flex-1 flex flex-col min-w-0 bg-zinc-950">
          <PreviewPanel onExport={() => setExportOpen(true)} />
        </div>
        
        {/* 右侧操作区 / 元信息 */}
        <div className="w-[320px] flex-shrink-0 flex flex-col bg-zinc-950/50 border-l border-zinc-800/60 overflow-hidden">
          <FilterPanel />
        </div>
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
    </div>
  );
}

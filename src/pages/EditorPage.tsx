import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { PreviewPanel, type PreviewPanelHandle } from "@/components/PreviewPanel";
import { FilterPanel } from "@/components/FilterPanel";
import { PresetList } from "@/components/Editor/PresetList";
import { EditorToolbar } from "@/components/Editor/EditorToolbar";
import { AssetStrip } from "@/components/Editor/AssetStrip";
import { useStore } from "@/store";

export function EditorPage() {
  const { folderId } = useParams<{ folderId: string }>();
  const enterFolder = useStore((s) => s.enterFolder);
  const exitFolder = useStore((s) => s.exitFolder);
  const albums = useStore((s) => s.albums);
  const [showOriginal, setShowOriginal] = useState(false);
  const [showPresetList, setShowPresetList] = useState(true);
  const [scale, setScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const previewRef = useRef<PreviewPanelHandle>(null);

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

  const handleScaleChange = useCallback((s: number, fit: number) => {
    setScale(s);
    setFitScale(fit);
  }, []);

  return (
    <div className="flex-1 flex min-h-0 bg-zinc-950 overflow-hidden">
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <EditorToolbar
          showOriginal={showOriginal}
          onShowOriginalChange={setShowOriginal}
          scale={scale}
          fitScale={fitScale}
          onZoomFit={() => previewRef.current?.fitToView()}
          onZoomTo={(s) => previewRef.current?.setZoomLevel(s)}
          showPresetList={showPresetList}
          onTogglePresetList={() => setShowPresetList((v) => !v)}
        />
        <div className="flex-1 min-h-0 flex overflow-hidden">
          <div className="flex-1 min-w-0 overflow-hidden">
            <PreviewPanel
              ref={previewRef}
              showOriginal={showOriginal}
              onScaleChange={handleScaleChange}
            />
          </div>

          {showPresetList && <PresetList />}
        </div>
        <AssetStrip />
      </div>

      <div className="w-[320px] flex-shrink-0 flex flex-col bg-zinc-950/50 border-l border-zinc-800/60 overflow-hidden">
        <FilterPanel />
      </div>
    </div>
  );
}

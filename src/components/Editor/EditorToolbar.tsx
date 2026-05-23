import { ArrowLeft, RotateCcw, Eye, EyeOff, Download, ChevronDown, PanelRight, PanelRightClose } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStore } from "@/store";
import { useTranslation } from "react-i18next";

interface EditorToolbarProps {
  showOriginal: boolean;
  onShowOriginalChange: (v: boolean) => void;
  onExport: () => void;
  scale: number;
  fitScale: number;
  onZoomFit: () => void;
  onZoomTo: (scale: number) => void;
  showPresetList: boolean;
  onTogglePresetList: () => void;
}

const ZOOM_PRESETS = [0.5, 1, 2, 4];

export function EditorToolbar({
  showOriginal,
  onShowOriginalChange,
  onExport,
  scale,
  fitScale,
  onZoomFit,
  onZoomTo,
  showPresetList,
  onTogglePresetList,
}: EditorToolbarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const focusedId = useStore((s) => s.focusedId);
  const resetFilter = useStore((s) => s.resetFilter);
  const disabled = focusedId == null;

  const isFit = fitScale > 0 && Math.abs(scale - fitScale) < 0.001;
  const zoomLabel = isFit
    ? t("editor.zoom.fit")
    : `${Math.round(scale * 100)}%`;

  return (
    <div className="h-10 flex-shrink-0 flex items-center gap-2 px-3 border-b border-zinc-800/60 bg-zinc-950/50">
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 flex-shrink-0"
        onClick={() => navigate("/projects")}
        title={t("editor.back", "返回")}
      >
        <ArrowLeft size={14} />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="flex items-center gap-1 h-7 px-2 rounded text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
            title={t("editor.zoom.label")}
          >
            <span className="tabular-nums w-12 text-left">{zoomLabel}</span>
            <ChevronDown size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[8rem]">
          <DropdownMenuItem onClick={onZoomFit}>
            {t("editor.zoom.fit")}
          </DropdownMenuItem>
          {ZOOM_PRESETS.map((p) => (
            <DropdownMenuItem key={p} onClick={() => onZoomTo(p)}>
              {Math.round(p * 100)}%
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex-1 min-w-0" />

      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        disabled={disabled}
        onMouseDown={() => onShowOriginalChange(true)}
        onMouseUp={() => onShowOriginalChange(false)}
        onMouseLeave={() => onShowOriginalChange(false)}
        title={t("previewPanel.holdToCompare")}
      >
        {showOriginal ? <EyeOff size={13} /> : <Eye size={13} />}
        {t("previewPanel.holdToCompare")}
      </Button>

      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        disabled={disabled}
        onClick={() => resetFilter()}
        title={t("editor.reset")}
      >
        <RotateCcw size={13} />
        {t("editor.reset")}
      </Button>

      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        onClick={onTogglePresetList}
        title={t("editor.togglePresetList")}
      >
        {showPresetList ? <PanelRightClose size={13} /> : <PanelRight size={13} />}
        {t("editor.preset")}
      </Button>

      <Button
        size="sm"
        variant="default"
        className="h-7"
        disabled={disabled}
        onClick={onExport}
      >
        <Download size={13} />
        {t("editor.export")}
      </Button>
    </div>
  );
}

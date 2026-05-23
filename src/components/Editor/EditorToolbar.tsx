import { ArrowLeft, RotateCcw, Eye, EyeOff, Download } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { useTranslation } from "react-i18next";

interface EditorToolbarProps {
  showOriginal: boolean;
  onToggleShowOriginal: () => void;
  onExport: () => void;
}

export function EditorToolbar({ showOriginal, onToggleShowOriginal, onExport }: EditorToolbarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const focusedId = useStore((s) => s.focusedId);
  const resetFilter = useStore((s) => s.resetFilter);
  const disabled = focusedId == null;

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
      <div className="h-4 w-px bg-zinc-800" />
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
        disabled={disabled}
        onClick={onToggleShowOriginal}
      >
        {showOriginal ? <EyeOff size={13} /> : <Eye size={13} />}
        {showOriginal ? t("editor.hideOriginal") : t("editor.showOriginal")}
      </Button>

      <div className="ml-auto">
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
    </div>
  );
}

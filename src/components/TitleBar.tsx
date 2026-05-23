import { useState } from "react";
import { Settings, Download } from "lucide-react";
import { useMatch } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ExportTasksPopover } from "@/components/ExportTasksPopover";
import { SettingsDialog } from "@/components/Settings";
import { ExportDialog } from "@/components/ExportDialog";
import { useStore } from "@/store";
import { useTranslation } from "react-i18next";

export function TitleBar() {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const inEditor = !!useMatch("/projects/:folderId");
  const focusedId = useStore((s) => s.focusedId);

  return (
    <div
      data-tauri-drag-region
      className="h-10 flex-shrink-0 flex items-center pl-20 pr-3 bg-zinc-950 border-b border-zinc-800/60 select-none"
    >
      <div data-tauri-drag-region className="flex-1 h-full" />
      <div className="flex items-center gap-2 pr-1">
        <ExportTasksPopover />
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 flex-shrink-0"
          title={t("sidebar.settings")}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={14} />
        </Button>
        {inEditor && (
          <Button
            size="sm"
            variant="default"
            className="h-7"
            disabled={focusedId == null}
            onClick={() => setExportOpen(true)}
          >
            <Download size={13} />
            {t("editor.export")}
          </Button>
        )}
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
    </div>
  );
}

import { useState } from "react";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExportTasksPopover } from "@/components/ExportTasksPopover";
import { SettingsDialog } from "@/components/Settings";
import { useTranslation } from "react-i18next";

export function TitleBar() {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div
      data-tauri-drag-region
      className="h-10 flex-shrink-0 flex items-center pl-20 pr-3 bg-zinc-950 border-b border-zinc-800/60 select-none"
    >
      <div data-tauri-drag-region className="flex-1 h-full" />
      <div className="flex items-center gap-2">
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
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

import { useState } from "react";
import { api } from "@/api";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { useTranslation } from "react-i18next";

interface ClearCacheDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function ClearCacheDialog({ open, onOpenChange }: ClearCacheDialogProps) {
  const { t } = useTranslation();
  const [clearing, setClearing] = useState(false);

  async function handleClear() {
    setClearing(true);
    try {
      await api.clearAllData();
      useStore.setState({
        assets: [],
        presets: [],
        userLuts: [],
        userFonts: [],
        exportTasks: new Map(),
        taskDetails: new Map(),
        dismissedTaskIds: new Set(),
        progress: null,
        watermarkPresets: [],
      });
      onOpenChange(false);
      await useStore.getState().refreshAssets();
      await useStore.getState().refreshFacets();
      await useStore.getState().refreshPresets();
    } finally {
      setClearing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{t("clearCache.title")}</DialogTitle>
        <DialogDescription>
          {t("clearCache.desc1")}<strong className="text-zinc-200">{t("clearCache.descHighlight")}</strong>{t("clearCache.desc2")}
        </DialogDescription>
        <ul className="mt-3 space-y-1 text-sm text-zinc-400 list-disc list-inside">
          <li>{t("clearCache.item1")}</li>
          <li>{t("clearCache.item2")}</li>
          <li>{t("clearCache.item3")}</li>
          <li>{t("clearCache.item4")}</li>
          <li>{t("clearCache.item5")}</li>
        </ul>
        <p className="mt-3 text-xs text-amber-400">{t("clearCache.notice")}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={clearing}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={handleClear} disabled={clearing}>
            {clearing ? t("clearCache.clearing") : t("clearCache.confirmClear")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

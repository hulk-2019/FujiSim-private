import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export function CacheTab() {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
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
      setConfirmOpen(false);
      await useStore.getState().refreshAssets();
      await useStore.getState().refreshFacets();
      await useStore.getState().refreshPresets();
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        {t("clearCache.desc1")}
        <strong className="text-zinc-200">{t("clearCache.descHighlight")}</strong>
        {t("clearCache.desc2")}
      </p>
      <ul className="text-sm text-zinc-400 list-disc list-inside space-y-1">
        <li>{t("clearCache.item1")}</li>
        <li>{t("clearCache.item2")}</li>
        <li>{t("clearCache.item3")}</li>
        <li>{t("clearCache.item4")}</li>
        <li>{t("clearCache.item5")}</li>
      </ul>
      <p className="text-xs text-amber-400">{t("clearCache.notice")}</p>
      <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
        {t("clearCache.confirmClear")}
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogTitle>{t("clearCache.title")}</DialogTitle>
          <DialogDescription>{t("clearCache.desc1")}</DialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={clearing}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={handleClear} disabled={clearing}>
              {clearing ? t("clearCache.clearing") : t("clearCache.confirmClear")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

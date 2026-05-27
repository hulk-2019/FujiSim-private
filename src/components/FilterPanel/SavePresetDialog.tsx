import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStore } from "@/store";
import { api } from "@/api";

interface SavePresetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SavePresetDialog({ open, onOpenChange }: SavePresetDialogProps) {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const refreshPresets = useStore((s) => s.refreshPresets);
  const categories = useStore((s) => s.categories);

  const [saveName, setSaveName] = useState("");
  const [saveCategoryId, setSaveCategoryId] = useState<string>("__none__");

  useEffect(() => {
    if (!open) {
      setSaveName("");
      setSaveCategoryId("__none__");
    }
  }, [open]);

  async function handleSave() {
    if (!saveName.trim()) return;
    await api.savePreset({
      name: saveName.trim(),
      base_simulation: filter.base_simulation,
      grain_amount: filter.grain_amount,
      grain_size: filter.grain_size,
      grain_roughness: filter.grain_roughness,
      grain_color: filter.grain_color,
      exposure: filter.exposure,
      contrast: filter.contrast,
      brightness: filter.brightness,
      highlight_tone: filter.highlight_tone,
      shadow_tone: filter.shadow_tone,
      white: filter.white,
      black: filter.black,
      dehaze: filter.dehaze,
      vibrance: filter.vibrance,
      color_saturation: filter.color_saturation,
      clarity: filter.clarity,
      sharpness: filter.sharpness,
      wb_shift_r: filter.wb_shift_r,
      wb_shift_g: filter.wb_shift_g,
      wb_shift_b: filter.wb_shift_b,
      lut_file_path: filter.lut_file_path ?? null,
      is_builtin: false,
      category_id: saveCategoryId === "__none__" ? null : Number(saveCategoryId),
    });
    onOpenChange(false);
    await refreshPresets();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{t("filterPanel.savePresetTitle")}</DialogTitle>
        <DialogDescription>{t("filterPanel.savePresetDesc")}</DialogDescription>
        <Input
          className="mt-3"
          value={saveName}
          placeholder={t("filterPanel.savePresetPlaceholder")}
          onChange={(e) => setSaveName(e.target.value)}
        />
        <div className="mt-3 space-y-1">
          <label className="text-xs text-zinc-400">{t("filterPanel.savePresetCategory")}</label>
          <Select value={saveCategoryId} onValueChange={setSaveCategoryId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("editor.presetList.noCategory")}</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave}>{t("common.save")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

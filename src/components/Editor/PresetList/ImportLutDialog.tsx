import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";

export type ImportLutSource = "files" | "dir";

type Props = {
  open: boolean;
  source: ImportLutSource;
  onOpenChange: (open: boolean) => void;
  onConfirm: (categoryId: number | null) => void;
};

export function ImportLutDialog({ open, onOpenChange, onConfirm }: Props) {
  const { t } = useTranslation();
  const categories = useStore((s) => s.categories);
  const [value, setValue] = useState<string>("__none__");

  function handleConfirm() {
    const categoryId = value === "__none__" ? null : Number(value);
    onConfirm(categoryId);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="mb-3">
          <DialogTitle>{t("editor.presetList.importLutTitle")}</DialogTitle>
        </div>
        <div className="space-y-2">
          <label className="text-xs text-zinc-400">
            {t("editor.presetList.importLutSelectCategory")}
          </label>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">
                {t("editor.presetList.noCategory")}
              </SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleConfirm}>
            {t("editor.presetList.next")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

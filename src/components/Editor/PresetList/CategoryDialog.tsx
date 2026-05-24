import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { api } from "@/api";

const MAX_NAME_LEN = 20;

type Mode =
  | { mode: "create" }
  | { mode: "rename"; id: number; initialName: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Mode;

export function CategoryDialog(props: Props) {
  const { t } = useTranslation();
  const createCategory = useStore((s) => s.createCategory);
  const renameCategory = useStore((s) => s.renameCategory);

  const initial = props.mode === "rename" ? props.initialName : "";
  const [name, setName] = useState(initial);
  const [duplicate, setDuplicate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (props.open) {
      setName(initial);
      setDuplicate(false);
      setServerError(null);
    }
  }, [props.open, initial]);

  const excludeId = props.mode === "rename" ? props.id : null;

  useEffect(() => {
    if (!name.trim()) {
      setDuplicate(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const exists = await api
        .checkPresetCategoryNameExists(name.trim(), excludeId)
        .catch(() => false);
      setDuplicate(exists);
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [name, excludeId]);

  const trimmed = name.trim();
  const canSubmit = !!trimmed && !duplicate && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError(null);
    try {
      if (props.mode === "create") {
        await createCategory(trimmed);
      } else {
        await renameCategory(props.id, trimmed);
      }
      props.onOpenChange(false);
    } catch (e) {
      setServerError(String(e ?? ""));
    } finally {
      setSubmitting(false);
    }
  }

  const title =
    props.mode === "create"
      ? t("editor.presetList.newCategory")
      : t("editor.presetList.renameCategory");

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="mb-3">
          <DialogTitle>{title}</DialogTitle>
        </div>
        <div className="relative">
          <Input
            autoFocus
            placeholder={t("editor.presetList.categoryNamePlaceholder")}
            value={name}
            maxLength={MAX_NAME_LEN}
            onChange={(e) => setName(e.target.value.slice(0, MAX_NAME_LEN))}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-zinc-500">
            {name.length}/{MAX_NAME_LEN}
          </span>
        </div>
        {duplicate && (
          <p className="text-xs text-red-500">
            {t("editor.presetList.categoryNameExists")}
          </p>
        )}
        {serverError && (
          <p className="text-xs text-red-500">{serverError}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {t("common.confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

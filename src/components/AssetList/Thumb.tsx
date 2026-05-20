import { useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, FileImage, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { StarRating } from "../StarRating";
import { api } from "@/api";
import type { Asset } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";

export default function Thumb({
  asset,
  selected,
  focused,
  onClick,
  onToggleCheckbox,
  onRatingChange,
  onRenamed,
}: {
  asset: Asset;
  selected: boolean;
  focused: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggleCheckbox: () => void;
  onRatingChange: (v: number) => void;
  onRenamed: () => void;
}) {
  const { t } = useTranslation();
  const [renameOpen, setRenameOpen] = useState(false);
  const [editName, setEditName] = useState("");

  const src = useMemo(() => {
    if (!asset.is_raw) {
      try {
        return convertFileSrc(asset.file_path);
      } catch {
        return null;
      }
    }
    if (asset.cover_path) {
      try {
        return convertFileSrc(asset.cover_path);
      } catch {
        return null;
      }
    }
    return null;
  }, [asset.file_path, asset.is_raw, asset.id, asset.cover_path]);

  function openRename(e: React.MouseEvent) {
    e.stopPropagation();
    setEditName(asset.file_name);
    setRenameOpen(true);
  }

  async function commitRename() {
    const name = editName.trim();
    if (!name || name === asset.file_name) {
      setRenameOpen(false);
      return;
    }
    try {
      await api.renameAsset(asset.id, name);
      setRenameOpen(false);
      onRenamed();
    } catch (e) {
      const { toast } = await import("@/hooks/useToast");
      toast.error(t("assetGrid.renameFailed"), { description: String(e) });
    }
  }

  return (
    <>
      <div
        onClick={onClick}
        className={cn(
          "group relative rounded-md overflow-hidden bg-zinc-900/50 border cursor-pointer transition-all hover:border-zinc-700",
          focused ? "border-zinc-400 bg-zinc-800" : "border-zinc-800/80",
          selected && "ring-2 ring-primary ring-offset-1 ring-offset-zinc-950",
        )}
      >
        <div className="relative aspect-square flex items-center justify-center bg-zinc-950 overflow-hidden">
          {src ? (
            <>
              <img
                src={src}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 w-full h-full object-cover opacity-40 blur-xl scale-125"
              />
              <img
                src={src}
                alt={asset.file_name}
                loading="lazy"
                className="relative z-10 w-full h-full object-contain no-drag"
              />
            </>
          ) : (
            <div className="relative z-10 flex flex-col items-center text-zinc-500 text-xs gap-1">
              <FileImage size={28} />
              {asset.file_type || "RAW"}
            </div>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCheckbox();
            }}
            className={cn(
              "absolute z-20 top-1.5 right-1.5 w-5 h-5 rounded border-2 flex items-center justify-center transition-opacity",
              selected
                ? "bg-primary border-primary opacity-100"
                : "bg-zinc-950/60 border-zinc-300 opacity-0 group-hover:opacity-100",
            )}
            title={selected ? t("assetGrid.deselect") : t("assetGrid.select")}
          >
            {selected && (
              <Check
                size={12}
                className="text-primary-foreground"
                strokeWidth={3}
              />
            )}
          </button>
          <span className="absolute z-20 top-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-zinc-950/60 text-zinc-200 border border-zinc-50/10 backdrop-blur-sm">
            {asset.file_type ?? "?"}
          </span>
        </div>
        <div className="p-2.5 flex flex-col gap-2">
          <p
            className="text-xs text-zinc-200 truncate leading-none"
            title={asset.file_name}
          >
            {asset.file_name}
          </p>
          <div className="flex items-center justify-between mt-0.5">
            <StarRating
              value={asset.star_rating}
              onChange={onRatingChange}
              size={12}
            />
            <button
              type="button"
              onClick={openRename}
              className="shrink-0 text-zinc-600 hover:text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity"
              title={t("assetGrid.rename")}
            >
              <Pencil size={11} />
            </button>
          </div>
        </div>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogTitle>{t("assetGrid.rename")}</DialogTitle>
          <DialogDescription>{asset.file_name}</DialogDescription>
          <Input
            className="mt-3"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
            }}
            autoFocus
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={commitRename} disabled={!editName.trim()}>
              {t("common.confirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

import { useEffect, useRef } from "react";
import { Trash2, Layers, FolderOpen, HardDriveDownload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export interface ThumbMenuState {
  x: number;
  y: number;
  assetId: number;
  multi: boolean;
}

interface ThumbContextMenuProps {
  state: ThumbMenuState | null;
  onClose: () => void;
  onRequestDelete: (kind: "db" | "disk", multi: boolean) => void;
  onReveal: () => void;
}

export function ThumbContextMenu({
  state,
  onClose,
  onRequestDelete,
  onReveal,
}: ThumbContextMenuProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [state, onClose]);

  if (!state) return null;

  const items: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }[] = [];
  if (!state.multi) {
    items.push({
      icon: <Trash2 size={13} />,
      label: t("editor.strip.menu.delete"),
      onClick: () => { onRequestDelete("db", false); onClose(); },
      danger: true,
    });
  } else {
    items.push({
      icon: <Layers size={13} />,
      label: t("editor.strip.menu.batchDelete"),
      onClick: () => { onRequestDelete("db", true); onClose(); },
      danger: true,
    });
  }
  items.push({
    icon: <FolderOpen size={13} />,
    label: t("editor.strip.menu.revealInFinder"),
    onClick: () => { onReveal(); onClose(); },
  });
  if (!state.multi) {
    items.push({
      icon: <HardDriveDownload size={13} />,
      label: t("editor.strip.menu.deleteFromDisk"),
      onClick: () => { onRequestDelete("disk", false); onClose(); },
      danger: true,
    });
  } else {
    items.push({
      icon: <HardDriveDownload size={13} />,
      label: t("editor.strip.menu.batchDeleteFromDisk"),
      onClick: () => { onRequestDelete("disk", true); onClose(); },
      danger: true,
    });
  }

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[180px] rounded-md border border-zinc-700 bg-zinc-900 p-1 text-zinc-100 shadow-xl"
      style={{ left: state.x, top: state.y }}
    >
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          onClick={it.onClick}
          className={cn(
            "w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm text-left",
            "hover:bg-zinc-800",
            // it.danger && "text-red-400 hover:text-red-300",
            it.danger && "hover:text-red-300",
          )}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}

export interface ConfirmState {
  kind: "db" | "disk";
  ids: number[];
}

interface ConfirmDeleteDialogProps {
  state: ConfirmState | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDeleteDialog({ state, onCancel, onConfirm }: ConfirmDeleteDialogProps) {
  const { t } = useTranslation();
  const open = state != null;
  const isDisk = state?.kind === "disk";
  const count = state?.ids.length ?? 0;
  const multi = count > 1;

  const title = isDisk
    ? t("editor.strip.menu.confirmDiskDeleteTitle")
    : t("editor.strip.menu.confirmDeleteTitle");
  const desc = isDisk
    ? (multi
        ? t("editor.strip.menu.confirmBatchDiskDeleteDesc", { count })
        : t("editor.strip.menu.confirmDiskDeleteDesc"))
    : (multi
        ? t("editor.strip.menu.confirmBatchDeleteDesc", { count })
        : t("editor.strip.menu.confirmDeleteDesc"));

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="max-w-sm">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{desc}</DialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("editor.strip.menu.cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t("editor.strip.menu.confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

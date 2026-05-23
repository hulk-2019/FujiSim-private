import { useEffect, useState } from "react";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";
import type { Album } from "@/types";

function daysLeft(deletedAt: string | null): number {
  if (!deletedAt) return 30;
  const deleted = new Date(deletedAt).getTime();
  const expiry = deleted + 30 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((expiry - Date.now()) / (24 * 60 * 60 * 1000)));
}

export function TrashPage() {
  const { t } = useTranslation();
  const trashedAlbums = useStore((s) => s.trashedAlbums);
  const refreshTrash = useStore((s) => s.refreshTrash);
  const restoreAlbum = useStore((s) => s.restoreAlbum);
  const purgeAlbum = useStore((s) => s.purgeAlbum);
  const purgeAllTrash = useStore((s) => s.purgeAllTrash);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmPurgeOpen, setConfirmPurgeOpen] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  useEffect(() => {
    refreshTrash();
  }, []);

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === trashedAlbums.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(trashedAlbums.map((a) => a.id)));
    }
  }

  async function handleRestore() {
    await Promise.all([...selectedIds].map((id) => restoreAlbum(id)));
    setSelectedIds(new Set());
  }

  async function handlePurge() {
    await Promise.all([...selectedIds].map((id) => purgeAlbum(id)));
    setSelectedIds(new Set());
    setConfirmPurgeOpen(false);
  }

  async function handleClearAll() {
    await purgeAllTrash();
    setSelectedIds(new Set());
    setConfirmClearOpen(false);
  }

  const hasSelection = selectedIds.size > 0;
  const allSelected =
    trashedAlbums.length > 0 && selectedIds.size === trashedAlbums.length;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-zinc-950">
      <div className="px-6 py-4 border-b border-zinc-800/60 flex items-center justify-between">
        <h1 className="text-base font-medium text-zinc-100">{t("trash.title")}</h1>
        <div className="flex items-center gap-3">
          {hasSelection ? (
            <>
              <label className="flex items-center gap-1.5 text-sm text-zinc-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  className="accent-blue-500"
                />
                {t("trash.selectAll")}
              </label>
              <span className="text-sm text-zinc-400">
                {t("trash.selectedCount", { count: selectedIds.size })}
              </span>
              <Button size="sm" variant="outline" onClick={handleRestore}>
                {t("trash.restore")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setConfirmPurgeOpen(true)}
              >
                {t("trash.purge")}
              </Button>
            </>
          ) : (
            <>
              <span className="text-sm text-zinc-500">
                {t("trash.totalCount", { count: trashedAlbums.length })}
              </span>
              {trashedAlbums.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmClearOpen(true)}
                >
                  {t("trash.clearAll")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {trashedAlbums.length === 0 ? (
          <p className="text-zinc-500 text-sm text-center mt-16">
            {t("trash.empty")}
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
            {trashedAlbums.map((album) => (
              <TrashCard
                key={album.id}
                album={album}
                selected={selectedIds.has(album.id)}
                onToggle={() => toggleSelect(album.id)}
                daysLeftValue={daysLeft(album.deleted_at)}
              />
            ))}
          </div>
        )}
      </div>

      <Dialog open={confirmPurgeOpen} onOpenChange={setConfirmPurgeOpen}>
        <DialogContent>
          <DialogTitle>{t("trash.confirmPurgeTitle")}</DialogTitle>
          <p className="text-sm text-zinc-400 mt-2">{t("trash.confirmPurgeBody")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmPurgeOpen(false)}>
              {t("trash.cancel")}
            </Button>
            <Button variant="destructive" onClick={handlePurge}>
              {t("trash.delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <DialogContent>
          <DialogTitle>{t("trash.confirmClearTitle")}</DialogTitle>
          <p className="text-sm text-zinc-400 mt-2">{t("trash.confirmClearBody")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmClearOpen(false)}>
              {t("trash.cancel")}
            </Button>
            <Button variant="destructive" onClick={handleClearAll}>
              {t("trash.delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface TrashCardProps {
  album: Album;
  selected: boolean;
  onToggle: () => void;
  daysLeftValue: number;
}

export function TrashCard({
  album,
  selected,
  onToggle,
  daysLeftValue,
}: TrashCardProps) {
  const { t } = useTranslation();
  return (
    <div
      onClick={onToggle}
      className={`rounded-xl bg-zinc-900 cursor-pointer overflow-hidden border-2 transition-colors ${
        selected ? "border-blue-500" : "border-transparent hover:border-zinc-700"
      }`}
    >
      <div className="aspect-[4/3] bg-zinc-800 flex items-center justify-center text-zinc-600 text-xs">
        {t("trash.totalCount", { count: 0 })}
      </div>
      <div className="px-3 py-2">
        <p className="text-sm font-medium text-zinc-100 truncate">{album.name}</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          {t("trash.daysLeft", { days: daysLeftValue })}
        </p>
      </div>
    </div>
  );
}

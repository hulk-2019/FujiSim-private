import { useState, useMemo } from "react";
import { Plus, Search, MoreHorizontal, Folder } from "lucide-react";
import { useStore } from "@/store";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "react-i18next";
import type { Album } from "@/types";

export function FolderList() {
  const { t } = useTranslation();
  const albums = useStore((s) => s.albums);
  const refreshAlbums = useStore((s) => s.refreshAlbums);
  const enterFolder = useStore((s) => s.enterFolder);

  const [search, setSearch] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newNameError, setNewNameError] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Album | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Album | null>(null);
  const [deleteCount, setDeleteCount] = useState<number | null>(null);

  const filtered = useMemo(
    () =>
      albums.filter((a) =>
        a.name.toLowerCase().includes(search.toLowerCase()),
      ),
    [albums, search],
  );

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const exists = await api.checkAlbumNameExists(name);
    if (exists) {
      setNewNameError(t("folder.nameExists"));
      return;
    }
    await api.createAlbum(name);
    setNewName("");
    setNewOpen(false);
    setNewNameError("");
    await refreshAlbums();
  }

  async function openRename(album: Album) {
    setRenameTarget(album);
    setRenameName(album.name);
    setRenameError("");
    setRenameOpen(true);
  }

  async function handleRename() {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name) return;
    const exists = await api.checkAlbumNameExists(name, renameTarget.id);
    if (exists) {
      setRenameError(t("folder.nameExists"));
      return;
    }
    await api.renameAlbum(renameTarget.id, name);
    setRenameOpen(false);
    setRenameTarget(null);
    await refreshAlbums();
  }

  async function openDelete(album: Album) {
    const count = await api.getFolderAssetCount(album.id);
    setDeleteTarget(album);
    setDeleteCount(count);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    await api.deleteFolder(deleteTarget.id);
    setDeleteTarget(null);
    setDeleteCount(null);
    await refreshAlbums();
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 顶部工具栏 */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-zinc-800/60">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2 top-2 text-zinc-500" />
          <Input
            className="h-7 pl-7 text-xs"
            placeholder={t("folder.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 flex-shrink-0"
          title={t("folder.newFolder")}
          onClick={() => { setNewName(""); setNewNameError(""); setNewOpen(true); }}
        >
          <Plus size={14} />
        </Button>
      </div>

      {/* 文件夹卡片网格 */}
      <div className="flex-1 overflow-y-auto p-2">
        {filtered.length === 0 && (
          <div className="flex items-center justify-center h-full text-zinc-500 text-xs p-4 text-center">
            {t("folder.noFolders")}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          {filtered.map((album) => (
            <div
              key={album.id}
              className="relative rounded-lg bg-zinc-900 hover:bg-zinc-800/80 cursor-pointer p-3 flex flex-col items-center gap-2 group"
              onClick={() => enterFolder(album.id, album.name)}
            >
              <Folder size={32} className="text-zinc-400 flex-shrink-0" />
              <span className="text-xs text-center truncate w-full">{album.name}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="absolute top-1.5 right-1.5 h-6 w-6 opacity-0 group-hover:opacity-100"
                  >
                    <MoreHorizontal size={13} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openRename(album); }}>
                    {t("folder.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={(e) => { e.stopPropagation(); openDelete(album); }}
                  >
                    {t("folder.delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      </div>

      {/* 新建弹框 */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogTitle>{t("folder.newFolder")}</DialogTitle>
          <Input
            className="mt-3"
            placeholder={t("folder.namePlaceholder")}
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setNewNameError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          />
          {newNameError && <p className="text-xs text-destructive mt-1">{newNameError}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={handleCreate} disabled={!newName.trim()}>{t("common.confirm")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 重命名弹框 */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogTitle>{t("folder.rename")}</DialogTitle>
          <Input
            className="mt-3"
            placeholder={t("folder.namePlaceholder")}
            value={renameName}
            onChange={(e) => { setRenameName(e.target.value); setRenameError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleRename(); }}
          />
          {renameError && <p className="text-xs text-destructive mt-1">{renameError}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={handleRename} disabled={!renameName.trim()}>{t("common.confirm")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹框 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) { setDeleteTarget(null); setDeleteCount(null); } }}>
        <DialogContent>
          <DialogTitle>{t("folder.delete")}</DialogTitle>
          <p className="text-sm text-zinc-400 mt-2">
            {deleteCount !== null && deleteCount > 0
              ? t("folder.confirmDelete", { count: deleteCount })
              : t("folder.confirmDeleteEmpty")}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setDeleteTarget(null); setDeleteCount(null); }}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={handleDelete}>{t("folder.delete")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

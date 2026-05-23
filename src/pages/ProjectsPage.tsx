import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, MoreHorizontal } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "@/store";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "react-i18next";
import type { AlbumSummary } from "@/types";

export function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const albumSummaries = useStore((s) => s.albumSummaries);
  const refreshAlbumSummaries = useStore((s) => s.refreshAlbumSummaries);
  const refreshAlbums = useStore((s) => s.refreshAlbums);

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newNameError, setNewNameError] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<AlbumSummary | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState("");

  // 进入页面时刷新一次，避免从编辑器导入素材后回来看到的是导入前的快照
  useEffect(() => {
    refreshAlbumSummaries();
  }, [refreshAlbumSummaries]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const exists = await api.checkAlbumNameExists(name);
    if (exists) {
      setNewNameError(t("projects.nameExists"));
      return;
    }
    const album = await api.createAlbum(name);
    setNewName("");
    setNewOpen(false);
    setNewNameError("");
    await Promise.all([refreshAlbums(), refreshAlbumSummaries()]);
    navigate(`/projects/${album.id}`);
  }

  async function handleRename() {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name) return;
    const exists = await api.checkAlbumNameExists(name, renameTarget.id);
    if (exists) {
      setRenameError(t("projects.nameExists"));
      return;
    }
    await api.renameAlbum(renameTarget.id, name);
    setRenameOpen(false);
    setRenameTarget(null);
    await Promise.all([refreshAlbums(), refreshAlbumSummaries()]);
  }

  async function handleDelete(summary: AlbumSummary) {
    await api.deleteFolder(summary.id);
    await Promise.all([refreshAlbums(), refreshAlbumSummaries()]);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-zinc-950">
      <div className="px-6 py-4 border-b border-zinc-800/60 flex items-center justify-between">
        <h1 className="text-base font-medium text-zinc-100">{t("projects.title")}</h1>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
          <NewProjectCard
            onClick={() => {
              setNewName("");
              setNewNameError("");
              setNewOpen(true);
            }}
          />
          {albumSummaries.map((s) => (
            <ProjectCard
              key={s.id}
              summary={s}
              onClick={() => navigate(`/projects/${s.id}`)}
              onRename={() => {
                setRenameTarget(s);
                setRenameName(s.name);
                setRenameError("");
                setRenameOpen(true);
              }}
              onDelete={() => handleDelete(s)}
              renameLabel={t("projects.rename")}
              deleteLabel={t("projects.delete")}
            />
          ))}
        </div>
        {albumSummaries.length === 0 && (
          <p className="text-zinc-500 text-sm text-center mt-16">
            {t("projects.noProjects")}
          </p>
        )}
      </div>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogTitle>{t("projects.newProject")}</DialogTitle>
          <Input
            className="mt-3"
            placeholder={t("projects.namePlaceholder")}
            maxLength={40}
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              setNewNameError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
          {newNameError && (
            <p className="text-xs text-destructive mt-1">{newNameError}</p>
          )}
          <div className="mt-4 flex justify-end">
            <Button onClick={handleCreate} disabled={!newName.trim()}>
              {t("projects.save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogTitle>{t("projects.rename")}</DialogTitle>
          <Input
            className="mt-3"
            placeholder={t("projects.namePlaceholder")}
            maxLength={40}
            value={renameName}
            onChange={(e) => {
              setRenameName(e.target.value);
              setRenameError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
            }}
          />
          {renameError && (
            <p className="text-xs text-destructive mt-1">{renameError}</p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleRename} disabled={!renameName.trim()}>
              {t("common.confirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NewProjectCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="aspect-[4/3] rounded-xl border-2 border-dashed border-zinc-700 hover:border-zinc-500 flex items-center justify-center transition-colors"
    >
      <Plus size={32} className="text-zinc-600" />
    </button>
  );
}

interface ProjectCardProps {
  summary: AlbumSummary;
  onClick: () => void;
  onRename: () => void;
  onDelete: () => void;
  renameLabel: string;
  deleteLabel: string;
}

export function ProjectCard({
  summary,
  onClick,
  onRename,
  onDelete,
  renameLabel,
  deleteLabel,
}: ProjectCardProps) {
  const covers = summary.cover_paths.slice(0, 4);

  return (
    <div
      className="rounded-xl bg-zinc-900 hover:bg-zinc-800/80 cursor-pointer overflow-hidden group relative"
      onClick={onClick}
    >
      <div className="grid grid-cols-2 aspect-[4/3]">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-zinc-800 overflow-hidden">
            {covers[i] ? (
              <img
                src={convertFileSrc(covers[i])}
                className="w-full h-full object-cover"
                alt=""
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="px-3 py-2">
        <p className="text-sm font-medium text-zinc-100 truncate">{summary.name}</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          {new Date(summary.created_at).toLocaleDateString("zh-CN")}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button
            size="icon"
            variant="ghost"
            className="absolute top-2 right-2 h-6 w-6 opacity-0 group-hover:opacity-100"
          >
            <MoreHorizontal size={13} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
          >
            {renameLabel}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            {deleteLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

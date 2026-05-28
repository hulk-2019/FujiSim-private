import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "@/store";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";
import type { ProjectSummary } from "@/types";

export function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projectSummaries = useStore((s) => s.projectSummaries);
  const refreshProjectSummaries = useStore((s) => s.refreshProjectSummaries);
  const refreshProjects = useStore((s) => s.refreshProjects);

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newNameError, setNewNameError] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);

  // 进入页面时刷新一次，避免从编辑器导入素材后回来看到的是导入前的快照
  useEffect(() => {
    refreshProjectSummaries();
  }, [refreshProjectSummaries]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const exists = await api.checkProjectNameExists(name);
    if (exists) {
      setNewNameError(t("projects.nameExists"));
      return;
    }
    const project = await api.createProject(name);
    setNewName("");
    setNewOpen(false);
    setNewNameError("");
    await Promise.all([refreshProjects(), refreshProjectSummaries()]);
    navigate(`/projects/${project.id}`);
  }

  async function handleRename() {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name) return;
    const exists = await api.checkProjectNameExists(name, renameTarget.id);
    if (exists) {
      setRenameError(t("projects.nameExists"));
      return;
    }
    await api.renameProject(renameTarget.id, name);
    setRenameOpen(false);
    setRenameTarget(null);
    await Promise.all([refreshProjects(), refreshProjectSummaries()]);
  }

  async function handleDelete(summary: ProjectSummary) {
    await api.deleteFolder(summary.id);
    await Promise.all([refreshProjects(), refreshProjectSummaries()]);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    await handleDelete(target);
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
          {projectSummaries.map((s) => (
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
              onDelete={() => setDeleteTarget(s)}
              renameLabel={t("projects.rename")}
              deleteLabel={t("projects.delete")}
            />
          ))}
        </div>
        {projectSummaries.length === 0 && (
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

      <Dialog
        open={deleteTarget != null}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogTitle>
            {t("projects.confirmDeleteTitle", { name: deleteTarget?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>
            {(deleteTarget?.total ?? 0) > 0
              ? t("projects.confirmDeleteDesc", { count: deleteTarget?.total ?? 0 })
              : t("projects.confirmDeleteEmptyDesc")}
          </DialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t("projects.cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {t("projects.confirm")}
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
  summary: ProjectSummary;
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

  function renderCovers() {
    if (covers.length === 1) {
      return (
        <div className="aspect-[4/3] bg-zinc-800 overflow-hidden">
          <img src={convertFileSrc(covers[0])} className="w-full h-full object-cover" alt="" />
        </div>
      );
    }
    if (covers.length === 2) {
      return (
        <div className="grid grid-cols-2 aspect-[4/3]">
          {covers.map((c, i) => (
            <div key={i} className="bg-zinc-800 overflow-hidden">
              <img src={convertFileSrc(c)} className="w-full h-full object-cover" alt="" />
            </div>
          ))}
        </div>
      );
    }
    if (covers.length === 3) {
      return (
        <div className="grid grid-cols-2 grid-rows-2 aspect-[4/3]">
          <div className="bg-zinc-800 overflow-hidden">
            <img src={convertFileSrc(covers[0])} className="w-full h-full object-cover" alt="" />
          </div>
          <div className="bg-zinc-800 overflow-hidden">
            <img src={convertFileSrc(covers[1])} className="w-full h-full object-cover" alt="" />
          </div>
          <div className="col-span-2 flex justify-center bg-zinc-900">
            <div className="w-1/2 bg-zinc-800 overflow-hidden">
              <img src={convertFileSrc(covers[2])} className="w-full h-full object-cover" alt="" />
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="grid grid-cols-2 aspect-[4/3]">
        {covers.map((c, i) => (
          <div key={i} className="bg-zinc-800 overflow-hidden">
            <img src={convertFileSrc(c)} className="w-full h-full object-cover" alt="" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="rounded-xl bg-zinc-900 hover:bg-zinc-800/80 cursor-pointer overflow-hidden group relative"
      onClick={onClick}
    >
      {renderCovers()}
      <div className="px-3 py-2 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-zinc-100 truncate">{summary.name}</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            {new Date(summary.created_at).toLocaleDateString("zh-CN")}
          </p>
        </div>
        <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            title={renameLabel}
            aria-label={renameLabel}
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
            className="h-7 w-7 inline-flex items-center justify-center rounded text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-100"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            title={deleteLabel}
            aria-label={deleteLabel}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="h-7 w-7 inline-flex items-center justify-center rounded text-zinc-400 hover:bg-red-500/15 hover:text-red-400"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

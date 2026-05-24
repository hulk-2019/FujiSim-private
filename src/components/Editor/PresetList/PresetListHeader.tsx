import { useState } from "react";
import { ArrowLeft, Plus, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useStore } from "@/store";
import { api } from "@/api";
import { CategoryDialog } from "./CategoryDialog";
import { ImportLutDialog, type ImportLutSource } from "./ImportLutDialog";

type Props = {
  showPlus: boolean;
  search: string;
  setSearch: (v: string) => void;
};

export function PresetListHeader({ showPlus, search, setSearch }: Props) {
  const { t } = useTranslation();
  const refreshUserLuts = useStore((s) => s.refreshUserLuts);

  const [searching, setSearching] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [importDialog, setImportDialog] = useState<null | ImportLutSource>(null);

  function exitSearch() {
    setSearching(false);
    setSearch("");
  }

  async function pickLuts(categoryId: number | null, source: ImportLutSource) {
    if (source === "files") {
      const selected = await openDialog({
        multiple: true,
        filters: [{ name: "Cube LUT", extensions: ["cube", "CUBE"] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;
      await api.importLuts(paths, categoryId);
    } else {
      const selected = await openDialog({ directory: true, multiple: false });
      if (!selected || typeof selected !== "string") return;
      await api.importLutsFromDir(selected, categoryId);
    }
    await refreshUserLuts();
  }

  return (
    <div className="flex items-center justify-between px-2 py-2 border-b border-zinc-800/60">
      {searching ? (
        <div className="flex items-center gap-1 flex-1">
          <button
            type="button"
            onClick={exitSearch}
            className="text-zinc-400 hover:text-zinc-100"
            aria-label="back"
          >
            <ArrowLeft size={14} />
          </button>
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("editor.presetList.searchPlaceholder")}
            className="h-7 text-xs"
            onKeyDown={(e) => {
              if (e.key === "Escape") exitSearch();
            }}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="text-zinc-400 hover:text-zinc-100"
              aria-label="clear"
            >
              <X size={14} />
            </button>
          )}
        </div>
      ) : (
        <>
          <h2 className="text-sm font-medium text-zinc-200">
            {t("editor.presetList.title")}
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSearching(true)}
              className="text-zinc-400 hover:text-zinc-100"
              aria-label="search"
            >
              <Search size={14} />
            </button>
            {showPlus && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="text-zinc-400 hover:text-zinc-100"
                    aria-label="add"
                  >
                    <Plus size={16} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      {t("editor.presetList.importPreset")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => setImportDialog("files")}>
                        {t("editor.presetList.importFiles")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setImportDialog("dir")}>
                        {t("editor.presetList.importDir")}
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                    {t("editor.presetList.newCategory")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </>
      )}
      <CategoryDialog mode="create" open={createOpen} onOpenChange={setCreateOpen} />
      {importDialog && (
        <ImportLutDialog
          open
          source={importDialog}
          onOpenChange={(o) => !o && setImportDialog(null)}
          onConfirm={(categoryId) => pickLuts(categoryId, importDialog)}
        />
      )}
    </div>
  );
}

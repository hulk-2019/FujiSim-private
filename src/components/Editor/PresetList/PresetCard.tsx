import { Layers, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useStore } from "@/store";
import { api } from "@/api";
import { PASS_THROUGH_SIM, type FilterPreset, type FilterSettings, type UserLut } from "@/types";

export type PresetEntry =
  | { kind: "preset"; preset: FilterPreset }
  | { kind: "lut"; lut: UserLut };

type Props = {
  entry: PresetEntry;
  active: boolean;
  onApply: () => void;
};

export function PresetCard({ entry, active, onApply }: Props) {
  const { t } = useTranslation();
  const categories = useStore((s) => s.categories);
  const setPresetCategory = useStore((s) => s.setPresetCategory);
  const setUserLutCategory = useStore((s) => s.setUserLutCategory);
  const refreshPresets = useStore((s) => s.refreshPresets);
  const refreshUserLuts = useStore((s) => s.refreshUserLuts);

  const isPreset = entry.kind === "preset";
  const name = isPreset ? entry.preset.name : entry.lut.name;
  const Icon = isPreset ? SlidersHorizontal : Layers;

  async function handleMove(categoryId: number | null) {
    if (entry.kind === "preset") {
      await setPresetCategory(entry.preset.id, categoryId);
    } else {
      await setUserLutCategory(entry.lut.id, categoryId);
    }
  }

  async function handleDelete() {
    const confirmKey =
      entry.kind === "preset"
        ? "editor.presetList.confirmDeletePreset"
        : "editor.presetList.confirmDeleteLut";
    if (!window.confirm(t(confirmKey))) return;
    if (entry.kind === "preset") {
      await api.deletePreset(entry.preset.id);
      await refreshPresets();
    } else {
      await api.deleteUserLut(entry.lut.id);
      await refreshUserLuts();
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onApply}
          title={name}
          className={cn(
            "w-full flex items-center gap-2 text-left rounded-md border px-2 py-1.5 text-xs transition-colors",
            active
              ? "border-blue-500 bg-blue-500/10 text-zinc-100"
              : "border-zinc-800 hover:border-zinc-600 text-zinc-300",
          )}
        >
          <Icon size={14} className="flex-shrink-0" />
          <span className="truncate">{name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {t("editor.presetList.moveToCategory")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onClick={() => handleMove(null)}>
              {t("editor.presetList.noCategory")}
            </ContextMenuItem>
            {categories.map((c) => (
              <ContextMenuItem key={c.id} onClick={() => handleMove(c.id)}>
                {c.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={handleDelete}>
          {t("editor.presetList.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Helper invoked by callers to apply a preset/LUT entry. */
export function applyEntry(
  entry: PresetEntry,
  setFilter: (patch: Partial<FilterSettings>) => void,
  applyPreset: (p: FilterPreset) => void,
  markPresetApplied?: () => void,
) {
  if (entry.kind === "preset") {
    applyPreset(entry.preset);
  } else {
    setFilter({ base_simulation: PASS_THROUGH_SIM, lut_file_path: entry.lut.file_path });
    markPresetApplied?.();
  }
}

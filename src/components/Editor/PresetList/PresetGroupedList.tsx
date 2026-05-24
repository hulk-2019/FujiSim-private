import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useStore } from "@/store";
import { CategoryDialog } from "./CategoryDialog";
import { PresetCard, applyEntry, type PresetEntry } from "./PresetCard";
import type { FilterSettings } from "@/types";

type Props = { search: string };

const UNCATEGORIZED_KEY = "__uncategorized__";

export function PresetGroupedList({ search }: Props) {
  const { t } = useTranslation();
  const categories = useStore((s) => s.categories);
  const presets = useStore((s) => s.presets);
  const userLuts = useStore((s) => s.userLuts);
  const filter = useStore((s) => s.filter);
  const applyPreset = useStore((s) => s.applyPreset);
  const setFilter = useStore((s) => s.setFilter);
  const deleteCategory = useStore((s) => s.deleteCategory);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renameTarget, setRenameTarget] = useState<{ id: number; name: string } | null>(null);

  const lower = search.trim().toLowerCase();

  const grouped = useMemo(() => {
    const buckets = new Map<string, PresetEntry[]>();
    buckets.set(UNCATEGORIZED_KEY, []);
    for (const c of categories) buckets.set(String(c.id), []);

    for (const p of presets) {
      if (p.is_builtin) continue;
      const key =
        p.category_id == null || !buckets.has(String(p.category_id))
          ? UNCATEGORIZED_KEY
          : String(p.category_id);
      buckets.get(key)!.push({ kind: "preset", preset: p });
    }
    for (const l of userLuts) {
      const key =
        l.category_id == null || !buckets.has(String(l.category_id))
          ? UNCATEGORIZED_KEY
          : String(l.category_id);
      buckets.get(key)!.push({ kind: "lut", lut: l });
    }

    function matches(e: PresetEntry): boolean {
      if (!lower) return true;
      const name = e.kind === "preset" ? e.preset.name : e.lut.name;
      return name.toLowerCase().includes(lower);
    }

    const order: { key: string; label: string }[] = [
      { key: UNCATEGORIZED_KEY, label: t("editor.presetList.uncategorized") },
      ...categories
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
        .map((c) => ({ key: String(c.id), label: c.name })),
    ];

    return order.map(({ key, label }) => {
      const items = (buckets.get(key) ?? []).filter(matches);
      return { key, label, items };
    });
  }, [presets, userLuts, categories, lower, t]);

  function toggle(key: string) {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  }

  function isActive(entry: PresetEntry): boolean {
    if (entry.kind === "preset") {
      return (
        filter.base_simulation === entry.preset.base_simulation
        && (filter.lut_file_path ?? null) === (entry.preset.lut_file_path ?? null)
      );
    }
    return filter.lut_file_path === entry.lut.file_path;
  }

  return (
    <div className="space-y-3">
      {grouped.map((group) => {
        if (lower && group.items.length === 0) return null;
        const open = !collapsed.has(group.key);
        const isUncategorized = group.key === UNCATEGORIZED_KEY;
        const categoryId = isUncategorized ? null : Number(group.key);
        const Header = (
          <button
            type="button"
            data-testid="category-header"
            onClick={() => toggle(group.key)}
            className="flex items-center gap-1 w-full text-left text-xs text-zinc-300 hover:text-zinc-100"
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="truncate">{group.label}</span>
            <span className="text-zinc-500 ml-1">({group.items.length})</span>
          </button>
        );
        return (
          <div key={group.key}>
            {isUncategorized ? (
              Header
            ) : (
              <ContextMenu>
                <ContextMenuTrigger asChild>{Header}</ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onClick={() =>
                      setRenameTarget({ id: categoryId!, name: group.label })
                    }
                  >
                    {t("editor.presetList.rename")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={async () => {
                      if (!window.confirm(t("editor.presetList.confirmDeleteCategory"))) return;
                      await deleteCategory(categoryId!);
                    }}
                  >
                    {t("editor.presetList.delete")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )}
            {open && (
              <div className="mt-1 space-y-1 pl-4">
                {group.items.length === 0 ? (
                  <p className="text-[11px] text-zinc-600">
                    {t("editor.presetList.emptyCategory")}
                  </p>
                ) : (
                  group.items.map((entry) => {
                    const itemKey =
                      entry.kind === "preset"
                        ? `preset-${entry.preset.id}`
                        : `lut-${entry.lut.id}`;
                    return (
                      <PresetCard
                        key={itemKey}
                        entry={entry}
                        active={isActive(entry)}
                        onApply={() =>
                          applyEntry(
                            entry,
                            (patch: Partial<FilterSettings>) => setFilter(patch),
                            applyPreset,
                          )
                        }
                      />
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
      {renameTarget && (
        <CategoryDialog
          mode="rename"
          id={renameTarget.id}
          initialName={renameTarget.name}
          open={true}
          onOpenChange={(o) => {
            if (!o) setRenameTarget(null);
          }}
        />
      )}
    </div>
  );
}

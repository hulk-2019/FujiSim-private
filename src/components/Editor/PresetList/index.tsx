import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useStore } from "@/store";
import type { FilterSettings } from "@/types";
import { PresetListHeader } from "./PresetListHeader";
import { PresetGroupedList } from "./PresetGroupedList";
import { PresetCard, applyEntry, type PresetEntry } from "./PresetCard";

export function PresetList() {
  const { t } = useTranslation();
  const presets = useStore((s) => s.presets);
  const filter = useStore((s) => s.filter);
  const applyPreset = useStore((s) => s.applyPreset);
  const setFilter = useStore((s) => s.setFilter);
  const setFilterInteraction = useStore((s) => s.setFilterInteraction);
  const refreshPresets = useStore((s) => s.refreshPresets);
  const refreshUserLuts = useStore((s) => s.refreshUserLuts);
  const refreshCategories = useStore((s) => s.refreshCategories);

  const [tab, setTab] = useState<"builtin" | "mine">("builtin");
  const [search, setSearch] = useState("");

  useEffect(() => {
    void refreshPresets();
    void refreshUserLuts();
    void refreshCategories();
  }, [refreshPresets, refreshUserLuts, refreshCategories]);

  const builtinFiltered = useMemo(() => {
    const q = search.toLowerCase();
    return presets.filter((p) => p.is_builtin && p.name.toLowerCase().includes(q));
  }, [presets, search]);

  return (
    <aside className="w-[220px] flex-shrink-0 flex flex-col bg-zinc-950 border-l border-zinc-800/60 overflow-hidden">
      <PresetListHeader showPlus={tab === "mine"} search={search} setSearch={setSearch} />
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "builtin" | "mine")}
        className="flex-1 flex flex-col overflow-hidden"
      >
        <div className="px-2 pt-2">
          <TabsList className="w-full grid grid-cols-2">
            <TabsTrigger value="builtin">{t("editor.presetList.builtin")}</TabsTrigger>
            <TabsTrigger value="mine">{t("editor.presetList.mine")}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="builtin" className="flex-1 overflow-y-auto px-2 mt-2 space-y-1">
          {builtinFiltered.map((p) => {
            const entry: PresetEntry = { kind: "preset", preset: p };
            const active = filter.base_simulation === p.base_simulation;
            return (
              <PresetCard
                key={p.id}
                entry={entry}
                active={active}
                onApply={() =>
                  applyEntry(
                    entry,
                    (patch: Partial<FilterSettings>) => setFilter(patch),
                    applyPreset,
                    () => setFilterInteraction("preset_applied"),
                  )
                }
              />
            );
          })}
        </TabsContent>
        <TabsContent value="mine" className="flex-1 overflow-y-auto px-2 mt-2">
          <PresetGroupedList search={search} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

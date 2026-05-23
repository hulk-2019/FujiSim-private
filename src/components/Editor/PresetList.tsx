import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useStore } from "@/store";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { FilterPreset } from "@/types";

export function PresetList() {
  const { t } = useTranslation();
  const presets = useStore((s) => s.presets);
  const filter = useStore((s) => s.filter);
  const applyPreset = useStore((s) => s.applyPreset);
  const currentFolderName = useStore((s) => s.currentFolderName);

  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"builtin" | "mine">("builtin");

  const filtered = useMemo(() => {
    const isBuiltin = tab === "builtin";
    return presets.filter(
      (p) =>
        !!p.is_builtin === isBuiltin &&
        p.name.toLowerCase().includes(search.toLowerCase()),
    );
  }, [presets, tab, search]);

  return (
    <aside className="w-[220px] flex-shrink-0 flex flex-col bg-zinc-950 border-l border-zinc-800/60 overflow-hidden">
      <div className="h-10 flex-shrink-0 flex items-center px-3 border-b border-zinc-800/60">
        <span className="text-sm text-zinc-200 truncate">{currentFolderName ?? ""}</span>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "builtin" | "mine")} className="flex-1 flex flex-col overflow-hidden">
        <div className="px-2 pt-2">
          <TabsList className="w-full grid grid-cols-2">
            <TabsTrigger value="builtin">{t("editor.presetList.builtin")}</TabsTrigger>
            <TabsTrigger value="mine">{t("editor.presetList.mine")}</TabsTrigger>
          </TabsList>
        </div>

        <div className="relative px-2 mt-2">
          <Search size={12} className="absolute left-4 top-2 text-zinc-500" />
          <Input
            placeholder={t("editor.presetList.searchPlaceholder")}
            className="h-7 pl-7 text-xs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <TabsContent value="builtin" className="flex-1 overflow-y-auto px-2 mt-2 space-y-1">
          {filtered.map((p) => (
            <PresetCard key={p.id} preset={p} active={filter.base_simulation === p.base_simulation} onApply={() => applyPreset(p)} />
          ))}
        </TabsContent>
        <TabsContent value="mine" className="flex-1 overflow-y-auto px-2 mt-2 space-y-1">
          {filtered.length === 0 && (
            <p className="text-[11px] text-zinc-600 px-2 pt-2">{t("filterPanel.noPresets")}</p>
          )}
          {filtered.map((p) => (
            <PresetCard key={p.id} preset={p} active={false} onApply={() => applyPreset(p)} />
          ))}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

export function PresetCard({ preset, active, onApply }: { preset: FilterPreset; active: boolean; onApply: () => void }) {
  return (
    <button
      type="button"
      onClick={onApply}
      className={cn(
        "w-full text-left rounded-md border px-2 py-2 text-xs transition-colors",
        active
          ? "border-blue-500 bg-blue-500/10 text-zinc-100"
          : "border-zinc-800 hover:border-zinc-600 text-zinc-300",
      )}
    >
      <p className="font-medium truncate">{preset.name}</p>
      <p className="text-[10px] text-zinc-500 truncate mt-0.5">{preset.base_simulation}</p>
    </button>
  );
}

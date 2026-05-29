import { ArrowLeft, Plus, Search, Trash2, X } from "lucide-react";
import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { useStore } from "@/store";
import { DEFAULT_WATERMARK, type WatermarkPosition, type WatermarkPreset, type WatermarkSettings } from "@/types";
import { buildWatermarkSvg, svgToDataUrl } from "@/lib/watermarkSvg";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const PRESET_STYLE_KEYS = ["whiteBottom", "blackBottom", "italicCenter", "smallBottomRight"] as const;
const PRESET_STYLES_DATA: { text: string; fontSize: number; color: string; opacity: number; italic: boolean; position: WatermarkPosition }[] = [
  { text: "© FujiSim", fontSize: 32, color: "#ffffff", opacity: 0.75, italic: false, position: "bottom-center" },
  { text: "© FujiSim", fontSize: 32, color: "#000000", opacity: 0.6,  italic: false, position: "bottom-center" },
  { text: "SAMPLE",    fontSize: 48, color: "#ffffff", opacity: 0.3,  italic: true,  position: "center" },
  { text: "© 2025",   fontSize: 18, color: "#ffffff", opacity: 0.8,  italic: false, position: "bottom-center" },
];
const CARD_PREVIEW_W = 220;
const CARD_PREVIEW_H = 84;
const CARD_PREVIEW_FONT_SIZE = 26;

export function WatermarkPresetPanel() {
  const { t } = useTranslation();
  const wm = useStore((s) => s.watermark);
  const setWatermark = useStore((s) => s.setWatermark);
  const watermarkPresets = useStore((s) => s.watermarkPresets);
  const removeWatermarkPreset = useStore((s) => s.removeWatermarkPreset);
  const applyWatermarkPreset = useStore((s) => s.applyWatermarkPreset);
  const userWatermarkSvgs = useStore((s) => s.userWatermarkSvgs);
  const importWatermarkSvgs = useStore((s) => s.importWatermarkSvgs);
  const removeUserWatermarkSvg = useStore((s) => s.removeUserWatermarkSvg);
  const applyImportedWatermarkSvg = useStore((s) => s.applyImportedWatermarkSvg);
  const selectedId = useStore((s) => s.selectedWatermarkPresetId);
  const setSelectedId = useStore((s) => s.setSelectedWatermarkPresetId);
  const [tab, setTab] = useState<"recommended" | "custom">("recommended");
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);

  const presetStyles = PRESET_STYLE_KEYS.map((key, i) => ({
    label: t(`watermark.presetStyles.${key}`),
    ...PRESET_STYLES_DATA[i],
  }));
  const lowerSearch = search.trim().toLowerCase();
  const recommendedFiltered = presetStyles.filter((p) => p.label.toLowerCase().includes(lowerSearch));
  const userSvgsFiltered = userWatermarkSvgs.filter((item) => item.name.toLowerCase().includes(lowerSearch));
  const presetsFiltered = watermarkPresets.filter((preset) => preset.name.toLowerCase().includes(lowerSearch));

  function applyPreset(p: typeof presetStyles[number]) {
    const id = recommendedId(p);
    setWatermark({
      enabled: true,
      kind: "text",
      source: "builtin",
      name: id,
      text: p.text,
      fontSize: p.fontSize,
      color: p.color,
      opacity: p.opacity,
      bold: false,
      italic: p.italic,
      position: p.position,
      offsetX: 0,
      offsetY: 0,
    });
    setSelectedId(null);
  }

  async function importSvg() {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    const imported = await importWatermarkSvgs(paths);
    if (imported[0]) applyImportedWatermarkSvg(imported[0]);
  }

  function exitSearch() {
    setSearching(false);
    setSearch("");
  }

  return (
    <aside className="w-[220px] flex-shrink-0 flex flex-col bg-zinc-950 border-l border-zinc-800/60 overflow-hidden">
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
              {t("filterPanel.tabs.watermark")}
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
              {tab === "custom" && (
                <button
                  type="button"
                  onClick={importSvg}
                  title={t("watermark.importSvg")}
                  className="text-zinc-400 hover:text-zinc-100"
                  aria-label="add"
                >
                  <Plus size={16} />
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as "recommended" | "custom")}
        className="flex-1 flex flex-col overflow-hidden"
      >
        <div className="px-2 pt-2">
          <TabsList className="w-full grid grid-cols-2">
            <TabsTrigger value="recommended">{t("watermark.recommended")}</TabsTrigger>
            <TabsTrigger value="custom">{t("watermark.custom")}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="recommended" className="flex-1 overflow-y-auto px-2 mt-2">
          <div className="grid grid-cols-1 gap-2">
            {recommendedFiltered.map((p) => (
              <WatermarkStyleCard
                key={p.label}
                active={wm.source === "builtin" && wm.name === recommendedId(p)}
                label={p.label}
                wm={watermarkPreviewSettings({ kind: "text", text: p.text, color: p.color, opacity: p.opacity, italic: p.italic })}
                onClick={() => applyPreset(p)}
                onDoubleClick={() => {
                  if (wm.source === "builtin" && wm.name === recommendedId(p)) setWatermark({ enabled: false });
                }}
              />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="custom" className="flex-1 overflow-y-auto px-2 mt-2">
          <div className="grid grid-cols-1 gap-2">
            {userSvgsFiltered.map((item) => (
              <WatermarkStyleCard
                key={`svg-${item.id}`}
                active={wm.kind === "svg" && wm.svgId === item.id}
                label={item.name}
                wm={watermarkPreviewSettings({ kind: "svg", source: "imported", svgId: item.id, svgMarkup: item.preview_svg ?? "" })}
                onClick={() => applyImportedWatermarkSvg(item)}
                onDoubleClick={() => {
                  if (wm.kind === "svg" && wm.svgId === item.id) setWatermark({ enabled: false });
                }}
                onDelete={() => removeUserWatermarkSvg(item.id)}
              />
            ))}
            {presetsFiltered.map((preset) => (
              <WatermarkPresetCard
                key={`preset-${preset.id}`}
                active={selectedId === preset.id}
                preset={preset}
                onClick={() => applyWatermarkPreset(preset)}
                onDoubleClick={() => {
                  if (selectedId === preset.id) setWatermark({ enabled: false });
                }}
                onDelete={() => removeWatermarkPreset(preset.id)}
              />
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function recommendedId(p: { label: string }) {
  return `builtin:${p.label}`;
}

function watermarkPreviewSettings(patch: Partial<WatermarkSettings>): WatermarkSettings {
  return {
    ...DEFAULT_WATERMARK,
    enabled: true,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
    scale: 1,
    flipH: false,
    flipV: false,
    italicDegree: 0,
    ...patch,
    position: "center",
    fontSize: CARD_PREVIEW_FONT_SIZE,
    padding: 0,
  };
}

function WatermarkStyleCard({
  label,
  active,
  onClick,
  onDoubleClick,
  onDelete,
  wm,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  onDelete?: () => void;
  wm: WatermarkSettings;
}) {
  const preview = svgToDataUrl(buildWatermarkSvg(wm, CARD_PREVIEW_W, CARD_PREVIEW_H));
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        "relative h-20 min-w-0 rounded border bg-zinc-950 overflow-hidden text-left transition-colors",
        active
          ? "border-blue-400 bg-blue-500/10 shadow-[inset_0_0_0_1px_rgba(96,165,250,0.85)]"
          : "border-zinc-800 hover:border-zinc-600",
      )}
    >
      <div className={cn("flex h-12 w-full items-center justify-center bg-zinc-900", active && "bg-blue-950/25")}>
        <img src={preview} alt="" className="block h-full w-full object-contain" />
      </div>
      <span className={cn("block px-2 py-1 text-[11px] truncate", active ? "text-blue-100" : "text-zinc-300")}>{label}</span>
      {onDelete && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-zinc-950/80 text-zinc-500 hover:text-red-400"
        >
          <Trash2 size={11} />
        </span>
      )}
    </button>
  );
}

function WatermarkPresetCard({
  onClick,
  onDoubleClick,
  onDelete,
  active,
  preset,
}: {
  onClick: () => void;
  onDoubleClick?: () => void;
  onDelete: () => void;
  active?: boolean;
  preset: WatermarkPreset;
}) {
  let wm: WatermarkSettings | null = null;
  try {
    wm = watermarkPreviewSettings({ ...JSON.parse(preset.settings_json), enabled: true });
  } catch {
    wm = null;
  }

  return wm ? (
    <WatermarkStyleCard
      active={active}
      label={preset.name}
      wm={wm}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onDelete={onDelete}
    />
  ) : (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        "relative h-16 min-w-0 rounded border bg-zinc-950 hover:border-zinc-600 overflow-hidden text-left",
        active ? "border-blue-400 bg-blue-500/10" : "border-zinc-800",
      )}
    >
      <span className="block px-2 py-1 text-[11px] text-zinc-300 truncate">{preset.name}</span>
    </button>
  );
}

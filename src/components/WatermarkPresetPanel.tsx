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

const PRESET_STYLE_KEYS = [
  "cleanWhite",
  "softBlack",
  "goldSignature",
  "filmStamp",
  "rubyEditorial",
  "cyanMinimal",
  "monoArchive",
  "limeProof",
  "warmSerif",
  "blueCorner",
  "roseVertical",
  "amberDate",
  "silverLabel",
  "mintCenter",
  "noirBold",
  "violetMark",
  "tealScript",
  "sandCaption",
  "redProof",
  "iceTiny",
] as const;
type RecommendedWatermarkStyle = Pick<
  WatermarkSettings,
  | "bold"
  | "color"
  | "fontFamily"
  | "fontSize"
  | "italic"
  | "italicDegree"
  | "opacity"
  | "position"
  | "rotation"
  | "shadowBlur"
  | "shadowColor"
  | "shadowEnabled"
  | "shadowOffsetX"
  | "shadowOffsetY"
  | "strokeColor"
  | "strokeEnabled"
  | "strokeWidth"
  | "text"
>;
const PRESET_STYLES_DATA: RecommendedWatermarkStyle[] = [
  { text: "© FotoForge", fontSize: 32, fontFamily: "Arial, sans-serif", color: "#ffffff", opacity: 0.76, bold: false, italic: false, italicDegree: 0, position: "bottom-center", rotation: 0, shadowEnabled: true, shadowColor: "#000000", shadowBlur: 4, shadowOffsetX: 1, shadowOffsetY: 1, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
  { text: "© FotoForge", fontSize: 30, fontFamily: "Arial, sans-serif", color: "#111111", opacity: 0.55, bold: false, italic: false, italicDegree: 0, position: "bottom-center", rotation: 0, shadowEnabled: true, shadowColor: "#ffffff", shadowBlur: 3, shadowOffsetX: 0, shadowOffsetY: 1, strokeEnabled: false, strokeColor: "#ffffff", strokeWidth: 0 },
  { text: "FotoForge", fontSize: 40, fontFamily: "'Brush Script MT', 'Comic Sans MS', cursive", color: "#d8b45a", opacity: 0.82, bold: false, italic: true, italicDegree: 12, position: "bottom-right", rotation: -6, shadowEnabled: true, shadowColor: "#1a1204", shadowBlur: 8, shadowOffsetX: 2, shadowOffsetY: 3, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
  { text: "FILM 400", fontSize: 24, fontFamily: "'Courier New', Courier, monospace", color: "#f2eee3", opacity: 0.72, bold: true, italic: false, italicDegree: 0, position: "bottom-left", rotation: 0, shadowEnabled: false, shadowColor: "#000000", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, strokeEnabled: true, strokeColor: "#101010", strokeWidth: 1.5 },
  { text: "SAMPLE", fontSize: 46, fontFamily: "Georgia, 'Times New Roman', serif", color: "#d94a72", opacity: 0.38, bold: true, italic: true, italicDegree: 18, position: "center", rotation: -18, shadowEnabled: false, shadowColor: "#000000", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
  { text: "© FotoForge", fontSize: 26, fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", color: "#57d8ff", opacity: 0.72, bold: false, italic: false, italicDegree: 0, position: "top-right", rotation: 0, shadowEnabled: true, shadowColor: "#05222d", shadowBlur: 5, shadowOffsetX: 1, shadowOffsetY: 1, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
  { text: "ARCHIVE", fontSize: 28, fontFamily: "Menlo, Consolas, 'Courier New', monospace", color: "#d6d6d6", opacity: 0.55, bold: false, italic: false, italicDegree: 0, position: "top-left", rotation: 0, shadowEnabled: false, shadowColor: "#000000", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, strokeEnabled: true, strokeColor: "#242424", strokeWidth: 1 },
  { text: "PROOF", fontSize: 52, fontFamily: "Arial, sans-serif", color: "#b7ff2a", opacity: 0.32, bold: true, italic: false, italicDegree: 0, position: "center", rotation: 16, shadowEnabled: false, shadowColor: "#000000", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, strokeEnabled: true, strokeColor: "#111111", strokeWidth: 1 },
  { text: "FotoForge", fontSize: 34, fontFamily: "Palatino, 'Palatino Linotype', 'Book Antiqua', serif", color: "#f0c28b", opacity: 0.78, bold: false, italic: true, italicDegree: 10, position: "bottom-center", rotation: 0, shadowEnabled: true, shadowColor: "#241408", shadowBlur: 6, shadowOffsetX: 1, shadowOffsetY: 2, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
  { text: "© 2026", fontSize: 22, fontFamily: "Verdana, Geneva, sans-serif", color: "#73a7ff", opacity: 0.86, bold: true, italic: false, italicDegree: 0, position: "bottom-right", rotation: 0, shadowEnabled: true, shadowColor: "#071326", shadowBlur: 4, shadowOffsetX: 1, shadowOffsetY: 1, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
  { text: "FotoForge", fontSize: 28, fontFamily: "Futura, 'Century Gothic', Tahoma, sans-serif", color: "#ff7fb0", opacity: 0.62, bold: true, italic: false, italicDegree: 0, position: "right-center", rotation: -90, shadowEnabled: true, shadowColor: "#2a0715", shadowBlur: 5, shadowOffsetX: 1, shadowOffsetY: 1, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
  { text: "2026.05", fontSize: 24, fontFamily: "'Courier New', Courier, monospace", color: "#f5a524", opacity: 0.82, bold: false, italic: false, italicDegree: 0, position: "bottom-left", rotation: 0, shadowEnabled: true, shadowColor: "#1e1200", shadowBlur: 5, shadowOffsetX: 2, shadowOffsetY: 1, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
  { text: "FotoForge", fontSize: 30, fontFamily: "Optima, Candara, 'Segoe UI', sans-serif", color: "#c9d1d9", opacity: 0.65, bold: false, italic: false, italicDegree: 0, position: "bottom-right", rotation: 0, shadowEnabled: true, shadowColor: "#000000", shadowBlur: 10, shadowOffsetX: 0, shadowOffsetY: 2, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
  { text: "ORIGINAL", fontSize: 30, fontFamily: "'Gill Sans', 'Gill Sans MT', Calibri, sans-serif", color: "#7df2c4", opacity: 0.45, bold: true, italic: false, italicDegree: 0, position: "center", rotation: 0, shadowEnabled: false, shadowColor: "#000000", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, strokeEnabled: true, strokeColor: "#0d3328", strokeWidth: 1 },
  { text: "NOIR", fontSize: 42, fontFamily: "Georgia, 'Times New Roman', serif", color: "#0b0b0b", opacity: 0.5, bold: true, italic: false, italicDegree: 0, position: "center", rotation: -10, shadowEnabled: true, shadowColor: "#ffffff", shadowBlur: 4, shadowOffsetX: 1, shadowOffsetY: 1, strokeEnabled: false, strokeColor: "#ffffff", strokeWidth: 0 },
  { text: "SIGNATURE", fontSize: 24, fontFamily: "'Trebuchet MS', sans-serif", color: "#b48cff", opacity: 0.78, bold: true, italic: true, italicDegree: 8, position: "top-center", rotation: 0, shadowEnabled: true, shadowColor: "#180d2b", shadowBlur: 5, shadowOffsetX: 0, shadowOffsetY: 2, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
  { text: "FotoForge", fontSize: 38, fontFamily: "Zapfino, 'Segoe Script', 'Comic Sans MS', cursive", color: "#2dd4bf", opacity: 0.82, bold: false, italic: true, italicDegree: 14, position: "bottom-left", rotation: -4, shadowEnabled: true, shadowColor: "#042f2e", shadowBlur: 7, shadowOffsetX: 2, shadowOffsetY: 2, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
  { text: "CAPTION", fontSize: 24, fontFamily: "Baskerville, 'Baskerville Old Face', serif", color: "#dec89f", opacity: 0.7, bold: false, italic: false, italicDegree: 0, position: "bottom-center", rotation: 0, shadowEnabled: true, shadowColor: "#1a1207", shadowBlur: 4, shadowOffsetX: 0, shadowOffsetY: 2, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
  { text: "DO NOT COPY", fontSize: 36, fontFamily: "Arial, sans-serif", color: "#ff4d4f", opacity: 0.34, bold: true, italic: false, italicDegree: 0, position: "center", rotation: -28, shadowEnabled: false, shadowColor: "#000000", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, strokeEnabled: true, strokeColor: "#ffffff", strokeWidth: 1.5 },
  { text: "©", fontSize: 20, fontFamily: "Arial, sans-serif", color: "#dff7ff", opacity: 0.85, bold: true, italic: false, italicDegree: 0, position: "top-left", rotation: 0, shadowEnabled: true, shadowColor: "#00151c", shadowBlur: 3, shadowOffsetX: 1, shadowOffsetY: 1, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 0 },
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
      fontFamily: p.fontFamily,
      color: p.color,
      opacity: p.opacity,
      bold: p.bold,
      italic: p.italic,
      italicDegree: p.italicDegree,
      position: p.position,
      rotation: p.rotation,
      shadowEnabled: p.shadowEnabled,
      shadowColor: p.shadowColor,
      shadowBlur: p.shadowBlur,
      shadowOffsetX: p.shadowOffsetX,
      shadowOffsetY: p.shadowOffsetY,
      strokeEnabled: p.strokeEnabled,
      strokeColor: p.strokeColor,
      strokeWidth: p.strokeWidth,
      offsetX: 0,
      offsetY: 0,
    });
    setSelectedId(null);
  }

  function isRecommendedActive(p: typeof presetStyles[number]) {
    return isRecommendedWatermarkActive(wm, recommendedId(p));
  }

  function handleRecommendedClick(p: typeof presetStyles[number]) {
    if (isRecommendedActive(p)) {
      setWatermark({ enabled: false });
      return;
    }
    applyPreset(p);
  }

  function isImportedActive(item: typeof userWatermarkSvgs[number]) {
    return isImportedWatermarkActive(wm, item.id);
  }

  function handleImportedClick(item: typeof userWatermarkSvgs[number]) {
    if (isImportedActive(item)) {
      setWatermark({ enabled: false });
      return;
    }
    applyImportedWatermarkSvg(item);
  }

  function isSavedPresetActive(preset: WatermarkPreset) {
    return isSavedWatermarkPresetActive(wm, selectedId, preset.id);
  }

  function handleSavedPresetClick(preset: WatermarkPreset) {
    if (isSavedPresetActive(preset)) {
      setWatermark({ enabled: false });
      setSelectedId(null);
      return;
    }
    applyWatermarkPreset(preset);
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
                active={isRecommendedActive(p)}
                label={p.label}
                wm={watermarkPreviewSettings({ kind: "text", ...p })}
                onClick={() => handleRecommendedClick(p)}
              />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="custom" className="flex-1 overflow-y-auto px-2 mt-2">
          <div className="grid grid-cols-1 gap-2">
            {userSvgsFiltered.map((item) => (
              <WatermarkStyleCard
                key={`svg-${item.id}`}
                active={isImportedActive(item)}
                label={item.name}
                wm={watermarkPreviewSettings({ kind: "svg", source: "imported", svgId: item.id, svgMarkup: item.preview_svg ?? "" })}
                onClick={() => handleImportedClick(item)}
                onDelete={() => removeUserWatermarkSvg(item.id)}
              />
            ))}
            {presetsFiltered.map((preset) => (
              <WatermarkPresetCard
                key={`preset-${preset.id}`}
                active={isSavedPresetActive(preset)}
                preset={preset}
                onClick={() => handleSavedPresetClick(preset)}
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

export function isRecommendedWatermarkActive(wm: WatermarkSettings, id: string) {
  return wm.enabled && wm.source === "builtin" && wm.name === id;
}

export function isImportedWatermarkActive(wm: WatermarkSettings, id: number) {
  return wm.enabled && wm.kind === "svg" && wm.svgId === id;
}

export function isSavedWatermarkPresetActive(
  wm: WatermarkSettings,
  selectedId: number | null,
  presetId: number,
) {
  return wm.enabled && selectedId === presetId;
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
  onDelete,
  wm,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  onDelete?: () => void;
  wm: WatermarkSettings;
}) {
  const preview = svgToDataUrl(buildWatermarkSvg(wm, CARD_PREVIEW_W, CARD_PREVIEW_H));
  return (
    <button
      type="button"
      onClick={onClick}
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
  onDelete,
  active,
  preset,
}: {
  onClick: () => void;
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
      onDelete={onDelete}
    />
  ) : (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative h-16 min-w-0 rounded border bg-zinc-950 hover:border-zinc-600 overflow-hidden text-left",
        active ? "border-blue-400 bg-blue-500/10" : "border-zinc-800",
      )}
    >
      <span className="block px-2 py-1 text-[11px] text-zinc-300 truncate">{preset.name}</span>
    </button>
  );
}

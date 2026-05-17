import { useState } from "react";
import { useStore } from "@/store";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { fontFamilyName } from "@/lib/fontManager";
import { Label, SliderRow, ToggleSwitch } from "@/components/ui/form";
import type { UserFont, WatermarkPosition, WatermarkPreset } from "@/types";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignHorizontalJustifyCenter,
  AlignVerticalJustifyCenter,
  Crosshair,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowUpLeft,
  ArrowUpRight,
  ArrowDownLeft,
  ArrowDownRight,
  FlipHorizontal,
  FlipVertical,
  RotateCcw,
  Trash2,
  Plus,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";

const BUILTIN_FONTS = [
  { value: "sans-serif",                                                    labelKey: "watermark.builtinFonts.sansSerif" },
  { value: "serif",                                                         labelKey: "watermark.builtinFonts.serif" },
  { value: "monospace",                                                     labelKey: "watermark.builtinFonts.monospace" },
  // 无衬线 — macOS / Windows 均有
  { value: "Arial, sans-serif",                                             label: "Arial" },
  { value: "'Helvetica Neue', Helvetica, Arial, sans-serif",                label: "Helvetica Neue" },
  { value: "'Gill Sans', 'Gill Sans MT', Calibri, sans-serif",              label: "Gill Sans / Calibri" },
  { value: "Futura, 'Century Gothic', Tahoma, sans-serif",                  label: "Futura / Century Gothic" },
  { value: "Optima, Candara, 'Segoe UI', sans-serif",                       label: "Optima / Candara" },
  { value: "Verdana, Geneva, sans-serif",                                   label: "Verdana" },
  { value: "'Trebuchet MS', sans-serif",                                    label: "Trebuchet MS" },
  { value: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",               label: "Segoe UI" },
  { value: "Tahoma, Geneva, sans-serif",                                    label: "Tahoma" },
  // 衬线 — macOS / Windows 均有
  { value: "Georgia, 'Times New Roman', serif",                             label: "Georgia" },
  { value: "'Times New Roman', Times, Georgia, serif",                      label: "Times New Roman" },
  { value: "Palatino, 'Palatino Linotype', 'Book Antiqua', serif",          label: "Palatino" },
  { value: "Garamond, 'EB Garamond', 'Cormorant Garamond', serif",          label: "Garamond" },
  { value: "Baskerville, 'Baskerville Old Face', 'Book Antiqua', serif",    label: "Baskerville" },
  { value: "Didot, 'Bodoni MT', 'Bodoni 72', serif",                        label: "Didot / Bodoni" },
  { value: "'Book Antiqua', Palatino, serif",                               label: "Book Antiqua" },
  // 等宽 — macOS / Windows 均有
  { value: "'Courier New', Courier, monospace",                             label: "Courier New" },
  { value: "Menlo, Consolas, 'Courier New', monospace",                     label: "Menlo / Consolas" },
  { value: "'Lucida Console', 'Lucida Sans Typewriter', monospace",         label: "Lucida Console" },
  // 手写 / 装饰 — fallback 到跨平台等效
  { value: "'Brush Script MT', 'Comic Sans MS', cursive",                   label: "Brush Script MT" },
  { value: "Zapfino, 'Segoe Script', 'Comic Sans MS', cursive",             label: "Zapfino / Segoe Script" },
  { value: "'Apple Chancery', 'Palatino Linotype', cursive",                label: "Apple Chancery" },
  { value: "Papyrus, fantasy",                                              label: "Papyrus" },
  { value: "'Comic Sans MS', cursive",                                      label: "Comic Sans MS" },
];

const PRESET_STYLE_KEYS = ["whiteBottom", "blackBottom", "italicCenter", "smallBottomRight"] as const;
const PRESET_STYLES_DATA: { text: string; fontSize: number; color: string; opacity: number; italic: boolean; position: WatermarkPosition }[] = [
  { text: "© FujiSim", fontSize: 32, color: "#ffffff", opacity: 0.75, italic: false, position: "bottom-center" },
  { text: "© FujiSim", fontSize: 32, color: "#000000", opacity: 0.6,  italic: false, position: "bottom-center" },
  { text: "SAMPLE",    fontSize: 48, color: "#ffffff", opacity: 0.3,  italic: true,  position: "center" },
  { text: "© 2025",   fontSize: 18, color: "#ffffff", opacity: 0.8,  italic: false, position: "bottom-center" },
];

const POSITION_BUTTON_KEYS: { value: WatermarkPosition; Icon: React.ElementType; titleKey: string }[] = [
  { value: "top-left",      Icon: ArrowUpLeft,                  titleKey: "watermark.positions.topLeft" },
  { value: "top-center",    Icon: AlignCenterHorizontal,        titleKey: "watermark.positions.topCenter" },
  { value: "top-right",     Icon: ArrowUpRight,                 titleKey: "watermark.positions.topRight" },
  { value: "left-center",   Icon: AlignVerticalJustifyCenter,   titleKey: "watermark.positions.middleLeft" },
  { value: "center",        Icon: Crosshair,                    titleKey: "watermark.positions.center" },
  { value: "right-center",  Icon: AlignHorizontalJustifyCenter, titleKey: "watermark.positions.middleRight" },
  { value: "bottom-left",   Icon: ArrowDownLeft,                titleKey: "watermark.positions.bottomLeft" },
  { value: "bottom-center", Icon: AlignCenterVertical,          titleKey: "watermark.positions.bottomCenter" },
  { value: "bottom-right",  Icon: ArrowDownRight,               titleKey: "watermark.positions.bottomRight" },
];

export function WatermarkTab() {
  const { t } = useTranslation();
  const wm = useStore((s) => s.watermark);
  const setWatermark = useStore((s) => s.setWatermark);
  const userFonts = useStore((s) => s.userFonts);
  const addUserFont = useStore((s) => s.addUserFont);
  const removeUserFont = useStore((s) => s.removeUserFont);
  const watermarkPresets = useStore((s) => s.watermarkPresets);
  const addWatermarkPreset = useStore((s) => s.addWatermarkPreset);
  const removeWatermarkPreset = useStore((s) => s.removeWatermarkPreset);
  const updateWatermarkPreset = useStore((s) => s.updateWatermarkPreset);
  const applyWatermarkPreset = useStore((s) => s.applyWatermarkPreset);
  const selectedId = useStore((s) => s.selectedWatermarkPresetId);
  const setSelectedId = useStore((s) => s.setSelectedWatermarkPresetId);

  const [selectValue, setSelectValue] = useState("");
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [dialogName, setDialogName] = useState("");
  const selectedPreset = watermarkPresets.find((p) => p.id === selectedId) ?? null;

  const presetStyles = PRESET_STYLE_KEYS.map((key, i) => ({
    label: t(`watermark.presetStyles.${key}`),
    ...PRESET_STYLES_DATA[i],
  }));

  function handleSelectPreset(v: string) {
    const builtin = presetStyles.find((p) => p.label === v);
    if (builtin) {
      applyPreset(builtin);
      setSelectedId(null);
      setSelectValue(v);
      return;
    }
    const custom = watermarkPresets.find((p) => p.id === Number(v));
    if (custom) {
      applyWatermarkPreset(custom);
      setSelectValue(v);
    }
  }

  function handleClearSelection() {
    setSelectedId(null);
    setSelectValue("");
  }

  function handleSave() {
    if (selectedPreset) {
      updateWatermarkPreset(selectedPreset.id, selectedPreset.name);
    } else {
      setDialogName("");
      setPresetDialogOpen(true);
    }
  }

  function handleSaveAs() {
    setDialogName(selectedPreset ? `${selectedPreset.name} ${t("common.copy")}` : "");
    setPresetDialogOpen(true);
  }

  async function submitNewPreset() {
    const name = dialogName.trim();
    if (!name) return;
    addWatermarkPreset(name);
    setPresetDialogOpen(false);
    const last = useStore.getState().watermarkPresets.at(-1);
    if (last) setSelectValue(String(last.id));
  }

  async function importFont() {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "Font", extensions: ["ttf", "otf", "woff", "woff2"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await addUserFont(paths);
  }

  async function handleRemoveFont(font: UserFont) {
    if (wm.fontFamily === fontFamilyName(font.id)) setWatermark({ fontFamily: "sans-serif" });
    await removeUserFont(font.id);
  }

  function applyPreset(p: typeof presetStyles[number]) {
    setWatermark({ text: p.text, fontSize: p.fontSize, color: p.color, opacity: p.opacity, italic: p.italic, position: p.position, offsetX: 0, offsetY: 0 });
  }

  const builtinFonts = BUILTIN_FONTS.map((f) => ({
    ...f,
    displayLabel: "labelKey" in f ? t(f.labelKey as any) : f.label,
  }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-300 font-semibold">{t("watermark.enable")}</span>
        <ToggleSwitch checked={wm.enabled} onChange={(v) => setWatermark({ enabled: v })} />
      </div>

      <div>
        <Label>{t("watermark.stylePreset")}</Label>
        <div className="flex items-center gap-1.5">
          <Select value={selectValue} onValueChange={handleSelectPreset}>
            <SelectTrigger className="h-7 text-xs flex-1"><SelectValue placeholder={t("watermark.stylePresetPlaceholder")} /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{t("watermark.builtin")}</SelectLabel>
                {presetStyles.map((p) => (
                  <SelectItem key={p.label} value={p.label}>{p.label}</SelectItem>
                ))}
              </SelectGroup>
              {watermarkPresets.length > 0 && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>{t("watermark.custom")}</SelectLabel>
                    {watermarkPresets.map((p) => (
                      <WatermarkPresetItem key={p.id} preset={p} onDelete={() => removeWatermarkPreset(p.id)} />
                    ))}
                  </SelectGroup>
                </>
              )}
            </SelectContent>
          </Select>
          {selectValue !== "" && (
            <button type="button" onClick={handleClearSelection} title={t("watermark.clearSelection")}
              className="h-7 w-7 flex items-center justify-center rounded border border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-200 shrink-0">
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div>
        <Label>{t("watermark.text")}</Label>
        <Input value={wm.text} onChange={(e) => setWatermark({ text: e.target.value })} placeholder={t("watermark.textPlaceholder")} className="h-7 text-xs" />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <Label>{t("watermark.font")}</Label>
          <button type="button" onClick={importFont}
            className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-200">
            <Plus size={10} /> {t("watermark.importFont")}
          </button>
        </div>
        <Select value={wm.fontFamily} onValueChange={(v) => setWatermark({ fontFamily: v })}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{t("watermark.builtin")}</SelectLabel>
              {builtinFonts.map((f) => (
                <SelectItem key={f.value} value={f.value}>{f.displayLabel}</SelectItem>
              ))}
            </SelectGroup>
            {userFonts.length > 0 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>{t("watermark.imported")}</SelectLabel>
                  {userFonts.map((f) => (
                    <UserFontItem key={f.id} font={f} onDelete={() => handleRemoveFont(f)} />
                  ))}
                </SelectGroup>
              </>
            )}
          </SelectContent>
        </Select>
      </div>

      <SliderRow label={t("watermark.fontSize")} value={wm.fontSize} min={8} max={120} step={1} onChange={(v) => setWatermark({ fontSize: v })} display={(v) => `${v}px`} />

      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-300">{t("watermark.bold")}</span>
        <ToggleSwitch checked={wm.bold} onChange={(v) => setWatermark({ bold: v })} />
      </div>

      <div>
        <Label>{t("watermark.color")}</Label>
        <div className="flex items-center gap-2">
          <input type="color" value={wm.color} onChange={(e) => setWatermark({ color: e.target.value })} className="h-7 w-10 rounded border border-zinc-700 bg-transparent cursor-pointer" />
          <Input value={wm.color} onChange={(e) => setWatermark({ color: e.target.value })} className="h-7 text-xs flex-1 font-mono" maxLength={7} />
        </div>
      </div>

      <SliderRow label={t("watermark.opacity")} value={wm.opacity} min={0} max={1} step={0.01} onChange={(v) => setWatermark({ opacity: v })} display={(v) => `${Math.round(v * 100)}%`} />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-300">{t("watermark.italic")}</span>
          <ToggleSwitch checked={wm.italic} onChange={(v) => setWatermark({ italic: v })} />
        </div>
        {wm.italic && (
          <SliderRow label={t("watermark.italicAngle")} value={wm.italicDegree} min={0} max={45} step={1} onChange={(v) => setWatermark({ italicDegree: v })} display={(v) => `${v}°`} />
        )}
      </div>

      <div className="space-y-2">
        <Label>{t("watermark.transform")}</Label>
        <SliderRow label={t("watermark.rotation")} value={wm.rotation} min={-180} max={180} step={1} onChange={(v) => setWatermark({ rotation: v })} display={(v) => `${v}°`} />
        <div className="flex items-center gap-2 mt-1">
          <button type="button" title={t("watermark.flipH")} onClick={() => setWatermark({ flipH: !wm.flipH })}
            className={cn("flex items-center gap-1.5 flex-1 justify-center h-7 rounded border text-xs transition-colors", wm.flipH ? "border-blue-600 text-blue-400" : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200")}>
            <FlipHorizontal size={13} /> {t("watermark.flipH")}
          </button>
          <button type="button" title={t("watermark.flipV")} onClick={() => setWatermark({ flipV: !wm.flipV })}
            className={cn("flex items-center gap-1.5 flex-1 justify-center h-7 rounded border text-xs transition-colors", wm.flipV ? "border-blue-600 text-blue-400" : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200")}>
            <FlipVertical size={13} /> {t("watermark.flipV")}
          </button>
          <button type="button" title={t("watermark.resetTransform")} onClick={() => setWatermark({ rotation: 0, flipH: false, flipV: false })}
            className="flex items-center justify-center h-7 w-7 rounded border border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 shrink-0">
            <RotateCcw size={12} />
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-300">{t("watermark.shadow")}</span>
          <ToggleSwitch checked={wm.shadowEnabled} onChange={(v) => setWatermark({ shadowEnabled: v })} />
        </div>
        {wm.shadowEnabled && (
          <div className="space-y-2 pl-2 border-l border-zinc-800">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400 w-12 shrink-0">{t("watermark.shadowColor")}</span>
              <input type="color" value={wm.shadowColor} onChange={(e) => setWatermark({ shadowColor: e.target.value })} className="h-6 w-8 rounded border border-zinc-700 bg-transparent cursor-pointer" />
              <Input value={wm.shadowColor} onChange={(e) => setWatermark({ shadowColor: e.target.value })} className="h-6 text-xs flex-1 font-mono" maxLength={7} />
            </div>
            <SliderRow label={t("watermark.shadowBlur")} value={wm.shadowBlur} min={0} max={20} step={1} onChange={(v) => setWatermark({ shadowBlur: v })} display={(v) => `${v}px`} />
            <SliderRow label={t("watermark.offsetX")} value={wm.shadowOffsetX} min={-10} max={10} step={1} onChange={(v) => setWatermark({ shadowOffsetX: v })} display={(v) => `${v}px`} />
            <SliderRow label={t("watermark.offsetY")} value={wm.shadowOffsetY} min={-10} max={10} step={1} onChange={(v) => setWatermark({ shadowOffsetY: v })} display={(v) => `${v}px`} />
          </div>
        )}
      </div>

      <div>
        <Label>{t("watermark.position")}</Label>
        <div className="grid grid-cols-3 gap-1 mb-2">
          {POSITION_BUTTON_KEYS.map((btn) => (
            <button key={btn.value} type="button" title={t(btn.titleKey as any)}
              onClick={() => setWatermark({ position: btn.value, offsetX: 0, offsetY: 0 })}
              className={cn("flex items-center justify-center h-7 rounded border text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors", wm.position === btn.value ? "border-blue-600 text-blue-400" : "border-zinc-700")}>
              <btn.Icon size={14} />
            </button>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{t("watermark.pixelAdjust")}</span>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-zinc-500">{t("watermark.stepSize")}</span>
              <Input type="number" value={wm.nudgeStep} min={1} max={100} onChange={(e) => setWatermark({ nudgeStep: Math.max(1, Number(e.target.value)) })} className="h-5 w-12 text-[10px] px-1 text-center" />
              <span className="text-[10px] text-zinc-500">px</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1 w-24 mx-auto">
            {[
              { onClick: () => setWatermark({ offsetX: wm.offsetX - wm.nudgeStep, offsetY: wm.offsetY - wm.nudgeStep }), Icon: ArrowUpLeft },
              { onClick: () => setWatermark({ offsetY: wm.offsetY - wm.nudgeStep }),                                      Icon: ChevronUp },
              { onClick: () => setWatermark({ offsetX: wm.offsetX + wm.nudgeStep, offsetY: wm.offsetY - wm.nudgeStep }), Icon: ArrowUpRight },
              { onClick: () => setWatermark({ offsetX: wm.offsetX - wm.nudgeStep }),                                      Icon: ChevronLeft },
              { onClick: () => setWatermark({ offsetX: 0, offsetY: 0 }), Icon: null, title: t("watermark.resetOffset") },
              { onClick: () => setWatermark({ offsetX: wm.offsetX + wm.nudgeStep }),                                      Icon: ChevronRight },
              { onClick: () => setWatermark({ offsetX: wm.offsetX - wm.nudgeStep, offsetY: wm.offsetY + wm.nudgeStep }), Icon: ArrowDownLeft },
              { onClick: () => setWatermark({ offsetY: wm.offsetY + wm.nudgeStep }),                                      Icon: ChevronDown },
              { onClick: () => setWatermark({ offsetX: wm.offsetX + wm.nudgeStep, offsetY: wm.offsetY + wm.nudgeStep }), Icon: ArrowDownRight },
            ].map((btn, i) => (
              <button key={i} type="button" title={"title" in btn ? btn.title : undefined} onClick={btn.onClick}
                className="flex items-center justify-center h-6 rounded border border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-zinc-200 text-[9px]">
                {btn.Icon ? <btn.Icon size={12} /> : "⊙"}
              </button>
            ))}
          </div>
          <div className="flex justify-center gap-3 text-[10px] text-zinc-500 tabular-nums">
            <span>X: {wm.offsetX > 0 ? "+" : ""}{wm.offsetX}px</span>
            <span>Y: {wm.offsetY > 0 ? "+" : ""}{wm.offsetY}px</span>
          </div>
        </div>
      </div>

      <div className="flex gap-1.5 pt-3 border-t border-zinc-800/60">
        <button type="button" onClick={handleSave}
          className="flex-1 h-8 px-2 text-xs rounded border border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800">
          {t("common.save")}
        </button>
        <button type="button" onClick={handleSaveAs}
          className="flex-1 h-8 px-2 text-xs rounded border border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800">
          {t("watermark.saveAs")}
        </button>
      </div>

      <Dialog open={presetDialogOpen} onOpenChange={setPresetDialogOpen}>
        <DialogContent>
          <DialogTitle>{t("watermark.newPresetTitle")}</DialogTitle>
          <DialogDescription>{t("watermark.newPresetDesc")}</DialogDescription>
          <Input
            autoFocus
            value={dialogName}
            onChange={(e) => setDialogName(e.target.value)}
            placeholder={t("watermark.newPresetPlaceholder")}
            className="mt-3"
            onKeyDown={(e) => { if (e.key === "Enter") submitNewPreset(); }}
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setPresetDialogOpen(false)}
              className="h-8 px-3 text-xs rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800">
              {t("common.cancel")}
            </button>
            <button type="button" disabled={!dialogName.trim()} onClick={submitNewPreset}
              className="h-8 px-3 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40">
              {t("common.save")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const CHECKMARK_SVG = (
  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

function SelectItemWithDelete({
  value,
  onDelete,
  children,
}: {
  value: string;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  return (
    <SelectPrimitive.Item
      value={value}
      className="group relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-sm outline-none focus:bg-zinc-800"
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>{CHECKMARK_SVG}</SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <button
        type="button"
        className="ml-auto opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 pl-2 shrink-0"
        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(); }}
      >
        <Trash2 size={11} />
      </button>
    </SelectPrimitive.Item>
  );
}

function UserFontItem({ font, onDelete }: { font: UserFont; onDelete: () => void }) {
  return (
    <SelectItemWithDelete value={fontFamilyName(font.id)} onDelete={onDelete}>
      <span style={{ fontFamily: fontFamilyName(font.id) }}>{font.name}</span>
    </SelectItemWithDelete>
  );
}

function WatermarkPresetItem({ preset, onDelete }: { preset: WatermarkPreset; onDelete: () => void }) {
  return (
    <SelectItemWithDelete value={String(preset.id)} onDelete={onDelete}>
      {preset.name}
    </SelectItemWithDelete>
  );
}

import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Save,
  Info,
  Camera,
  Aperture,
  Timer,
  Ruler,
  Calendar,
  HardDrive,
  Star,
  FileType,
  ImageIcon,
  SlidersHorizontal,
  Stamp,
  ScrollText,
  Palette,
  Pipette,
  RotateCcw,
  Sun,
  Droplets,
  Thermometer,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Section } from "@/components/ui/section";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useStore } from "@/store";
import { api } from "@/api";
import { PASS_THROUGH_SIM } from "@/types";
import { formatBytes, shortDate } from "@/lib/utils";
import { SliderRow } from "@/components/ui/form";
import { Histogram } from "@/components/Histogram";
import { WatermarkTab } from "@/components/WatermarkTab";
import { HslPanel } from "@/components/HslPanel";
import { useTranslation } from "react-i18next";
import { CurvesEditor } from "@/components/CurvesEditor";
import type { ToneCurvePoints } from "@/types";

export function FilterPanel() {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const resetFilter = useStore((s) => s.resetFilter);
  const refreshPresets = useStore((s) => s.refreshPresets);
  const categories = useStore((s) => s.categories);
  const assets = useStore((s) => s.assets);
  const focusedId = useStore((s) => s.focusedId);
  const eyedropperMode = useStore((s) => s.eyedropperMode);
  const setEyedropperMode = useStore((s) => s.setEyedropperMode);
  const histogram = useStore((s) => s.histogram);
  const focused = assets.find((a) => a?.id === focusedId) ?? null;

  const [wbMode, setWbMode] = useState<"reset" | "auto">("reset");

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveCategoryId, setSaveCategoryId] = useState<string>("__none__");

  useEffect(() => {
    refreshPresets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!saveOpen) {
      setSaveName("");
      setSaveCategoryId("__none__");
    }
  }, [saveOpen]);

  async function saveAsPreset() {
    if (!saveName.trim()) return;
    await api.savePreset({
      name: saveName.trim(),
      base_simulation: filter.base_simulation,
      grain_amount: filter.grain_amount,
      grain_size: filter.grain_size,
      grain_roughness: filter.grain_roughness,
      grain_color: filter.grain_color,
      exposure: filter.exposure,
      contrast: filter.contrast,
      brightness: filter.brightness,
      highlight_tone: filter.highlight_tone,
      shadow_tone: filter.shadow_tone,
      white: filter.white,
      black: filter.black,
      dehaze: filter.dehaze,
      vibrance: filter.vibrance,
      color_saturation: filter.color_saturation,
      clarity: filter.clarity,
      sharpness: filter.sharpness,
      wb_shift_r: filter.wb_shift_r,
      wb_shift_g: filter.wb_shift_g,
      wb_shift_b: filter.wb_shift_b,
      lut_file_path: filter.lut_file_path ?? null,
      is_builtin: false,
      category_id:
        saveCategoryId === "__none__" ? null : Number(saveCategoryId),
    });
    setSaveOpen(false);
    await refreshPresets();
  }

  return (
    <aside className="w-full h-full bg-transparent flex text-sm overflow-hidden">
      <Tabs
        defaultValue="adjust"
        className="flex-1 flex flex-row-reverse overflow-hidden"
      >
        <TabsList className="flex flex-col h-full w-11 flex-shrink-0 items-stretch gap-1 rounded-none bg-zinc-900/50 border-l border-zinc-800/60 p-1">
          <SideTabTrigger
            value="adjust"
            label={t("filterPanel.tabs.adjust")}
            icon={<SlidersHorizontal size={16} />}
          />
          <SideTabTrigger
            value="watermark"
            label={t("filterPanel.tabs.watermark")}
            icon={<Stamp size={16} />}
          />
          <SideTabTrigger
            value="info"
            label={t("filterPanel.tabs.info")}
            icon={<ScrollText size={16} />}
          />
        </TabsList>

        <TabsContent
          value="adjust"
          className="flex-1 min-w-0 overflow-hidden mt-0 data-[state=active]:flex data-[state=active]:flex-col select-none"
        >
          <ScrollArea className="flex-1">
            <div className="px-0 py-0 space-y-2">
              <Histogram data={histogram} />
              <Section
                title={t("editor.sections.whiteBalance")}
                icon={<Thermometer size={12} />}
              >
                <div className="flex items-center gap-1.5">
                  <Select
                    value={wbMode}
                    onValueChange={(v) => {
                      if (v === "auto") {
                        if (!focusedId) return;
                        api.autoWhiteBalance(focusedId).then((result) => {
                          setFilter({ wb_shift_r: result.wbShiftR, wb_shift_g: result.wbShiftG, wb_shift_b: result.wbShiftB });
                          setWbMode("auto");
                        });
                      }
                    }}
                  >
                    <SelectTrigger className="h-6 w-auto gap-1 border-zinc-700 bg-zinc-900 text-[10px] text-zinc-300 px-2 py-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-zinc-700 bg-zinc-900">
                      <SelectItem value="reset" className="text-[10px] text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100">
                        {t("filterPanel.wbReset")}
                      </SelectItem>
                      <SelectItem value="auto" className="text-[10px] text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100">
                        {t("filterPanel.wbAuto")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 w-6 p-0 border-zinc-700 hover:bg-zinc-800"
                    onClick={() => { setFilter({ wb_shift_r: 0, wb_shift_g: 0, wb_shift_b: 0 }); setWbMode("reset"); }}
                    title={t("filterPanel.wbReset")}
                  >
                    <RotateCcw size={12} />
                  </Button>
                  <Button
                    size="sm"
                    variant={eyedropperMode === "white-balance" ? "default" : "outline"}
                    className="h-6 w-6 p-0 border-zinc-700 hover:bg-zinc-800"
                    onClick={() => setEyedropperMode(eyedropperMode === "white-balance" ? "none" : "white-balance")}
                  >
                    <Pipette size={12} />
                  </Button>
                </div>
                <SliderRow
                  label={t("filterPanel.temperature")}
                  value={-filter.wb_shift_b}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => { setFilter({ wb_shift_b: -v }); setWbMode("reset"); }}
                  trackGradient="linear-gradient(to right, #4488ff, #cccc88, #ffcc00)"
                />
                <SliderRow
                  label={t("filterPanel.tint")}
                  value={-filter.wb_shift_g}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => { setFilter({ wb_shift_g: -v }); setWbMode("reset"); }}
                  trackGradient="linear-gradient(to right, #44cc44, #cccccc, #cc44cc)"
                />
              </Section>
              <Section
                title={t("editor.sections.basic")}
                icon={<Sun size={12} />}
              >
                {filter.base_simulation === PASS_THROUGH_SIM &&
                  filter.lut_file_path && (
                    <p className="mb-2 text-[10px] text-zinc-500">
                      {t("filterPanel.lutAppliedNotice")}
                    </p>
                  )}
                <SliderRow
                  label={t("filterPanel.exposure")}
                  value={filter.exposure}
                  min={-5}
                  max={5}
                  step={0.05}
                  display={(v) => v.toFixed(2)}
                  onChange={(v) => setFilter({ exposure: v })}
                />
                <SliderRow
                  label={t("filterPanel.contrast")}
                  value={filter.contrast}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ contrast: v })}
                />
                <SliderRow
                  label={t("filterPanel.brightness")}
                  value={filter.brightness}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ brightness: v })}
                />
                <SliderRow
                  label={t("filterPanel.highlight")}
                  value={filter.highlight_tone}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ highlight_tone: v })}
                />
                <SliderRow
                  label={t("filterPanel.shadow")}
                  value={filter.shadow_tone}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ shadow_tone: v })}
                />
                <SliderRow
                  label={t("filterPanel.white")}
                  value={filter.white}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ white: v })}
                />
                <SliderRow
                  label={t("filterPanel.black")}
                  value={filter.black}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ black: v })}
                />
                <SliderRow
                  label={t("filterPanel.dehaze")}
                  value={filter.dehaze}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ dehaze: v })}
                />
                <SliderRow
                  label={t("filterPanel.vibrance")}
                  value={filter.vibrance}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ vibrance: v })}
                />
                <SliderRow
                  label={t("filterPanel.saturation")}
                  value={filter.color_saturation}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ color_saturation: v })}
                />
              </Section>
              <Section
                title={t("hsl.title")}
                icon={<Palette size={12} />}
                defaultOpen={false}
              >
                <HslPanel />
              </Section>
              <Section
                title={t("editor.sections.curves")}
                icon={<TrendingUp size={12} />}
                defaultOpen={false}
              >
                <CurvesEditor
                  value={filter.tone_curve}
                  onChange={(tc: ToneCurvePoints) =>
                    setFilter({ tone_curve: tc })
                  }
                />
              </Section>
              <Section
                title={t("editor.sections.detail")}
                icon={<Sparkles size={12} />}
              >
                <SliderRow
                  label={t("filterPanel.clarity")}
                  value={filter.clarity}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ clarity: v })}
                />
                <SliderRow
                  label={t("filterPanel.sharpness")}
                  value={filter.sharpness}
                  min={-100}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ sharpness: v })}
                />
              </Section>
              <Section
                title={t("editor.sections.grain")}
                icon={<Droplets size={12} />}
                defaultOpen={false}
              >
                <SliderRow
                  label={t("filterPanel.grainAmount")}
                  value={filter.grain_amount}
                  min={0}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ grain_amount: v })}
                />
                <SliderRow
                  label={t("filterPanel.grainSize")}
                  value={filter.grain_size}
                  min={0}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ grain_size: v })}
                />
                <SliderRow
                  label={t("filterPanel.grainRoughness")}
                  value={filter.grain_roughness}
                  min={0}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ grain_roughness: v })}
                />
                <SliderRow
                  label={t("filterPanel.grainColor")}
                  value={filter.grain_color}
                  min={0}
                  max={100}
                  step={1}
                  display={(v) => v.toFixed(0)}
                  onChange={(v) => setFilter({ grain_color: v })}
                />
              </Section>
            </div>
          </ScrollArea>

          <div className="flex gap-2 px-3 py-3 border-t border-zinc-800/60">
            <Button
              size="sm"
              variant="outline"
              onClick={resetFilter}
              className="flex-1 border-zinc-800 hover:bg-zinc-800"
            >
              {t("common.reset")}
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={() => setSaveOpen(true)}
              className="flex-1"
            >
              <Save size={12} /> {t("filterPanel.saveAsPreset")}
            </Button>
          </div>
        </TabsContent>

        <TabsContent
          value="watermark"
          className="flex-1 min-w-0 overflow-hidden mt-0 data-[state=active]:flex data-[state=active]:flex-col select-none"
        >
          <WatermarkTab />
        </TabsContent>

        <TabsContent
          value="info"
          className="flex-1 min-w-0 overflow-y-auto px-3 pb-6 mt-0"
        >
          {focused ? (
            <div className="space-y-4 text-xs pt-3">
              <div className="rounded-md border border-zinc-800/80 bg-zinc-900/40 p-3 flex gap-3">
                <div className="w-16 h-16 flex-shrink-0 rounded overflow-hidden bg-zinc-900 border border-zinc-800/60 flex items-center justify-center">
                  {(() => {
                    const thumbSrc =
                      focused.cover_path ??
                      (!focused.is_raw ? focused.file_path : null);
                    return thumbSrc ? (
                      <img
                        src={convertFileSrc(thumbSrc)}
                        alt=""
                        className="w-full h-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      <ImageIcon size={20} className="text-zinc-700" />
                    );
                  })()}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <p
                    className="text-zinc-100 font-medium truncate"
                    title={focused.file_name}
                  >
                    {focused.file_name}
                  </p>
                  <p
                    className="text-zinc-500 break-all leading-relaxed text-[11px]"
                    title={focused.file_path}
                  >
                    {focused.file_path}
                  </p>
                </div>
              </div>

              <InfoGroup>
                <InfoRow
                  Icon={Camera}
                  label={t("filterPanel.metaCamera")}
                  value={focused.camera_model}
                />
                <InfoRow
                  Icon={ImageIcon}
                  label={t("filterPanel.metaLens")}
                  value={focused.lens_model}
                />
              </InfoGroup>

              <InfoGroup>
                <InfoRow
                  Icon={Aperture}
                  label={t("filterPanel.metaAperture")}
                  value={
                    focused.f_number != null
                      ? `f/${focused.f_number.toFixed(1)}`
                      : null
                  }
                />
                <InfoRow
                  Icon={Timer}
                  label={t("filterPanel.metaShutter")}
                  value={
                    focused.shutter_speed ? `${focused.shutter_speed}s` : null
                  }
                />
                <InfoRow
                  Icon={Ruler}
                  label={t("filterPanel.metaFocal")}
                  value={
                    focused.focal_length != null
                      ? `${focused.focal_length}mm`
                      : null
                  }
                />
              </InfoGroup>

              <InfoGroup>
                <InfoRow
                  Icon={Calendar}
                  label={t("filterPanel.metaDate")}
                  value={shortDate(focused.date_taken)}
                />
                <InfoRow
                  Icon={HardDrive}
                  label={t("filterPanel.metaSize")}
                  value={formatBytes(focused.file_size)}
                />
                <InfoRow
                  Icon={FileType}
                  label={t("filterPanel.metaType")}
                  value={focused.file_type || (focused.is_raw ? "RAW" : null)}
                />
                <InfoRow
                  Icon={Star}
                  label={t("filterPanel.metaRating")}
                  valueNode={
                    <div className="flex items-center gap-0.5">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Star
                          key={n}
                          size={11}
                          className={
                            n <= focused.star_rating
                              ? "text-amber-400 fill-amber-400"
                              : "text-zinc-700"
                          }
                        />
                      ))}
                    </div>
                  }
                />
              </InfoGroup>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center text-zinc-500 py-10 gap-2">
              <Info size={32} />
              <p>{t("filterPanel.noSelection")}</p>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogTitle>{t("filterPanel.savePresetTitle")}</DialogTitle>
          <DialogDescription>
            {t("filterPanel.savePresetDesc")}
          </DialogDescription>
          <Input
            className="mt-3"
            value={saveName}
            placeholder={t("filterPanel.savePresetPlaceholder")}
            onChange={(e) => setSaveName(e.target.value)}
          />
          <div className="mt-3 space-y-1">
            <label className="text-xs text-zinc-400">
              {t("filterPanel.savePresetCategory")}
            </label>
            <Select value={saveCategoryId} onValueChange={setSaveCategoryId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">
                  {t("editor.presetList.noCategory")}
                </SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={saveAsPreset}>{t("common.save")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function SideTabTrigger({
  value,
  label,
  icon,
}: {
  value: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <TabsTrigger
      value={value}
      aria-label={label}
      className="group relative h-9 w-full p-0 flex items-center justify-center"
    >
      {icon}
      <span
        role="tooltip"
        className="pointer-events-none absolute right-full mr-2 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md bg-zinc-900 text-zinc-100 text-xs px-2 py-1 shadow-lg border border-zinc-700/60 opacity-0 translate-x-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0 z-50"
      >
        {label}
      </span>
    </TabsTrigger>
  );
}

function InfoGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/40 divide-y divide-zinc-800/60">
      {children}
    </div>
  );
}

function InfoRow({
  Icon,
  label,
  value,
  valueNode,
}: {
  Icon: LucideIcon;
  label: string;
  value?: string | null;
  valueNode?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 min-w-0">
      <Icon size={12} className="text-zinc-500 flex-shrink-0" />
      <span className="text-zinc-500 text-[11px] flex-shrink-0">{label}</span>
      <div className="ml-auto min-w-0 text-right">
        {valueNode ?? (
          <span
            className="text-zinc-200 truncate block"
            title={value ?? undefined}
          >
            {value || "—"}
          </span>
        )}
      </div>
    </div>
  );
}

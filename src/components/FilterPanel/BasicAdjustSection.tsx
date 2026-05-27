import { Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Section } from "@/components/ui/section";
import { SliderRow } from "@/components/ui/form";
import { useStore } from "@/store";
import { PASS_THROUGH_SIM } from "@/types";

export function BasicAdjustSection() {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);

  return (
    <Section title={t("editor.sections.basic")} icon={<Sun size={12} />}>
      {filter.base_simulation === PASS_THROUGH_SIM && filter.lut_file_path && (
        <p className="mb-2 text-[10px] text-zinc-500">{t("filterPanel.lutAppliedNotice")}</p>
      )}
      <SliderRow label={t("filterPanel.exposure")} value={filter.exposure}
        min={-5} max={5} step={0.05} display={(v) => v.toFixed(2)}
        onChange={(v) => setFilter({ exposure: v })} />
      <SliderRow label={t("filterPanel.contrast")} value={filter.contrast}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ contrast: v })} />
      <SliderRow label={t("filterPanel.brightness")} value={filter.brightness}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ brightness: v })} />
      <SliderRow label={t("filterPanel.highlight")} value={filter.highlight_tone}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ highlight_tone: v })} />
      <SliderRow label={t("filterPanel.shadow")} value={filter.shadow_tone}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ shadow_tone: v })} />
      <SliderRow label={t("filterPanel.white")} value={filter.white}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ white: v })} />
      <SliderRow label={t("filterPanel.black")} value={filter.black}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ black: v })} />
      <SliderRow label={t("filterPanel.dehaze")} value={filter.dehaze}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ dehaze: v })} />
      <SliderRow label={t("filterPanel.vibrance")} value={filter.vibrance}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ vibrance: v })} />
      <SliderRow label={t("filterPanel.saturation")} value={filter.color_saturation}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ color_saturation: v })} />
    </Section>
  );
}

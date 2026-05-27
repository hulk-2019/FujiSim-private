import { Droplets } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Section } from "@/components/ui/section";
import { SliderRow } from "@/components/ui/form";
import { useStore } from "@/store";

export function GrainSection() {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);

  return (
    <Section title={t("editor.sections.grain")} icon={<Droplets size={12} />} defaultOpen={false}>
      <SliderRow label={t("filterPanel.grainAmount")} value={filter.grain_amount}
        min={0} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ grain_amount: v })} />
      <SliderRow label={t("filterPanel.grainSize")} value={filter.grain_size}
        min={0} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ grain_size: v })} />
      <SliderRow label={t("filterPanel.grainRoughness")} value={filter.grain_roughness}
        min={0} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ grain_roughness: v })} />
      <SliderRow label={t("filterPanel.grainColor")} value={filter.grain_color}
        min={0} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ grain_color: v })} />
    </Section>
  );
}

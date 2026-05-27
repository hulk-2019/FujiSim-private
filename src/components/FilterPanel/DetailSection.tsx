import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Section } from "@/components/ui/section";
import { SliderRow } from "@/components/ui/form";
import { useStore } from "@/store";

export function DetailSection() {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);

  return (
    <Section title={t("editor.sections.detail")} icon={<Sparkles size={12} />}>
      <SliderRow label={t("filterPanel.clarity")} value={filter.clarity}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ clarity: v })} />
      <SliderRow label={t("filterPanel.sharpness")} value={filter.sharpness}
        min={-100} max={100} step={1} display={(v) => v.toFixed(0)}
        onChange={(v) => setFilter({ sharpness: v })} />
    </Section>
  );
}

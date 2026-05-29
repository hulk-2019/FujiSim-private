import { useEffect, useState } from "react";
import {
  Save,
  SlidersHorizontal,
  Stamp,
  ScrollText,
  Palette,
  TrendingUp,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/section";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useStore } from "@/store";
import { HslPanel } from "@/components/HslPanel";
import { CurvesEditor } from "@/components/CurvesEditor";
import { WatermarkTab } from "@/components/WatermarkTab";
import type { ToneCurvePoints } from "@/types";

import { SideTabTrigger } from "./SideTabTrigger";
import { HistogramSection } from "./HistogramSection";
import { WhiteBalanceSection } from "./WhiteBalanceSection";
import { BasicAdjustSection } from "./BasicAdjustSection";
import { DetailSection } from "./DetailSection";
import { GrainSection } from "./GrainSection";
import { InfoTab } from "./InfoTab";
import { SavePresetDialog } from "./SavePresetDialog";

export function FilterPanel({
  onTabChange,
}: {
  onTabChange?: (tab: string) => void;
}) {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const resetFilter = useStore((s) => s.resetFilter);
  const refreshPresets = useStore((s) => s.refreshPresets);

  const [saveOpen, setSaveOpen] = useState(false);

  useEffect(() => {
    refreshPresets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <aside className="w-full h-full bg-transparent flex text-sm overflow-hidden">
      <Tabs defaultValue="adjust" onValueChange={onTabChange} className="flex-1 flex flex-row-reverse overflow-hidden">
        <TabsList className="flex flex-col h-full w-11 flex-shrink-0 items-stretch gap-1 rounded-none bg-zinc-900/50 border-l border-zinc-800/60 p-1">
          <SideTabTrigger value="adjust" label={t("filterPanel.tabs.adjust")} icon={<SlidersHorizontal size={16} />} />
          <SideTabTrigger value="watermark" label={t("filterPanel.tabs.watermark")} icon={<Stamp size={16} />} />
          <SideTabTrigger value="info" label={t("filterPanel.tabs.info")} icon={<ScrollText size={16} />} />
        </TabsList>

        <TabsContent
          value="adjust"
          className="flex-1 min-w-0 overflow-hidden mt-0 data-[state=active]:flex data-[state=active]:flex-col select-none"
        >
          <ScrollArea className="flex-1">
            <div className="px-0 py-0 space-y-2">
              <HistogramSection />
              <WhiteBalanceSection />
              <BasicAdjustSection />
              <Section title={t("hsl.title")} icon={<Palette size={12} />} defaultOpen={false}>
                <HslPanel />
              </Section>
              <Section title={t("editor.sections.curves")} icon={<TrendingUp size={12} />} defaultOpen={false}>
                <CurvesEditor
                  value={filter.tone_curve}
                  onChange={(tc: ToneCurvePoints) => setFilter({ tone_curve: tc })}
                />
              </Section>
              <DetailSection />
              <GrainSection />
            </div>
          </ScrollArea>

          <div className="flex gap-2 px-3 py-3 border-t border-zinc-800/60">
            <Button size="sm" variant="outline" onClick={resetFilter} className="flex-1 border-zinc-800 hover:bg-zinc-800">
              {t("common.reset")}
            </Button>
            <Button size="sm" variant="default" onClick={() => setSaveOpen(true)} className="flex-1">
              <Save size={12} /> {t("filterPanel.saveAsPreset")}
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="watermark"
          className="flex-1 min-w-0 overflow-hidden mt-0 data-[state=active]:flex data-[state=active]:flex-col select-none">
          <WatermarkTab />
        </TabsContent>

        <TabsContent value="info" className="flex-1 min-w-0 overflow-y-auto px-3 pb-6 mt-0">
          <InfoTab />
        </TabsContent>
      </Tabs>

      <SavePresetDialog open={saveOpen} onOpenChange={setSaveOpen} />
    </aside>
  );
}

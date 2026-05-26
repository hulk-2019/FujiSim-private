import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SliderRow } from "@/components/ui/form";
import { useStore } from "@/store";
import { useTranslation } from "react-i18next";

const HSL_RANGES = [
  { key: "red", color: "#ef4444" },
  { key: "orange", color: "#f97316" },
  { key: "yellow", color: "#eab308" },
  { key: "green", color: "#22c55e" },
  { key: "aqua", color: "#06b6d4" },
  { key: "blue", color: "#3b82f6" },
  { key: "purple", color: "#8b5cf6" },
  { key: "magenta", color: "#ec4899" },
];

type HslAttr = "hue" | "sat" | "lum";

function attrConfig(attr: HslAttr) {
  switch (attr) {
    case "hue":
      return { min: -100, max: 100, label: "hsl.hue" };
    case "sat":
      return { min: -100, max: 100, label: "hsl.saturation" };
    case "lum":
      return { min: -100, max: 100, label: "hsl.luminance" };
  }
}

export function HslPanel() {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);

  return (
    <Tabs defaultValue="hue" className="flex flex-col">
      <TabsList className="w-full flex-shrink-0 mb-2 h-7 text-xs">
        <TabsTrigger value="hue" className="flex-1 h-5">
          {t("hsl.hue")}
        </TabsTrigger>
        <TabsTrigger value="sat" className="flex-1 h-5">
          {t("hsl.saturation")}
        </TabsTrigger>
        <TabsTrigger value="lum" className="flex-1 h-5">
          {t("hsl.luminance")}
        </TabsTrigger>
      </TabsList>

      {(["hue", "sat", "lum"] as HslAttr[]).map((attr) => {
        const config = attrConfig(attr);
        return (
          <TabsContent key={attr} value={attr} className="mt-0 h-">
            <div className="space-y-3">
              {HSL_RANGES.map((range) => {
                const field = `hsl_${range.key}_${attr}` as keyof typeof filter;
                return (
                  <div key={range.key} className="flex items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 rounded-full shrink-0 border border-zinc-700/50"
                      style={{ backgroundColor: range.color }}
                    />
                    <div className="flex-1">
                      <SliderRow
                        label={t(`hsl.${range.key}`)}
                        value={(filter[field] as number) ?? 0}
                        min={config.min}
                        max={config.max}
                        step={1}
                        display={(v) => v.toFixed(0)}
                        onChange={(v) => setFilter({ [field]: v })}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

import { useState } from "react";
import { Thermometer, RotateCcw, Pipette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Section } from "@/components/ui/section";
import { SliderRow } from "@/components/ui/form";
import { useStore } from "@/store";
import { api } from "@/api";

export function WhiteBalanceSection() {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const setFilterInteraction = useStore((s) => s.setFilterInteraction);
  const focusedId = useStore((s) => s.focusedId);
  const projectId = useStore((s) => s.currentFolderId);
  const eyedropperMode = useStore((s) => s.eyedropperMode);
  const setEyedropperMode = useStore((s) => s.setEyedropperMode);
  const [wbMode, setWbMode] = useState<"reset" | "auto">("reset");

  return (
    <Section title={t("editor.sections.whiteBalance")} icon={<Thermometer size={12} />}>
      <div className="flex items-center gap-1.5">
        <Select
          value={wbMode}
          onValueChange={(v) => {
            if (v === "reset") {
              setFilter({ wb_shift_r: 0, wb_shift_g: 0, wb_shift_b: 0 });
              setFilterInteraction("preset_applied");
              setWbMode("reset");
              return;
            }
            if (v === "auto") {
              if (!focusedId) return;
              api.autoWhiteBalance(focusedId, projectId).then((result) => {
                setFilter({
                  wb_shift_r: result.wbShiftR,
                  wb_shift_g: result.wbShiftG,
                  wb_shift_b: result.wbShiftB,
                });
                setFilterInteraction("preset_applied");
                setWbMode("auto");
              });
            }
          }}
        >
          <SelectTrigger className="h-6 w-auto gap-1 border-zinc-700 bg-zinc-900 text-[10px] text-zinc-300 px-2 py-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-zinc-700 bg-zinc-900">
            <SelectItem
              value="reset"
              className="text-[10px] text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100"
            >
              {t("filterPanel.wbReset")}
            </SelectItem>
            <SelectItem
              value="auto"
              className="text-[10px] text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100"
            >
              {t("filterPanel.wbAuto")}
            </SelectItem>
          </SelectContent>
        </Select>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          className="h-6 w-6 p-0 border-zinc-700 hover:bg-zinc-800"
          onClick={() => {
            setFilter({ wb_shift_r: 0, wb_shift_g: 0, wb_shift_b: 0 });
            setFilterInteraction("preset_applied");
            setWbMode("reset");
          }}
          title={t("filterPanel.wbReset")}
        >
          <RotateCcw size={12} />
        </Button>
        <Button
          size="sm"
          variant={eyedropperMode === "white-balance" ? "default" : "outline"}
          className="h-6 w-6 p-0 border-zinc-700 hover:bg-zinc-800"
          onClick={() =>
            setEyedropperMode(eyedropperMode === "white-balance" ? "none" : "white-balance")
          }
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
        onChange={(v) => {
          setFilter({ wb_shift_b: -v });
          setWbMode("reset");
        }}
        trackGradient="linear-gradient(to right, #4488ff, #cccc88, #ffcc00)"
      />
      <SliderRow
        label={t("filterPanel.tint")}
        value={-filter.wb_shift_g}
        min={-100}
        max={100}
        step={1}
        display={(v) => v.toFixed(0)}
        onChange={(v) => {
          setFilter({ wb_shift_g: -v });
          setWbMode("reset");
        }}
        trackGradient="linear-gradient(to right, #44cc44, #cccccc, #cc44cc)"
      />
    </Section>
  );
}

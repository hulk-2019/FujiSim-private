import { useStore } from "@/store";
import { Histogram } from "@/components/Histogram";

export function HistogramSection() {
  const histogram = useStore((s) => s.histogram);
  const focusedId = useStore((s) => s.focusedId);
  const assets = useStore((s) => s.assets);
  const focused = assets.find((a) => a?.id === focusedId) ?? null;
  return <Histogram data={histogram} asset={focused} />;
}

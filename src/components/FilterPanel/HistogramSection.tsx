import { useStore } from "@/store";
import { Histogram } from "@/components/Histogram";

export function HistogramSection() {
  const histogram = useStore((s) => s.histogram);
  return <Histogram data={histogram} />;
}

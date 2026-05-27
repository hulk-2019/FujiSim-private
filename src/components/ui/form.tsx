import { Slider } from "@/components/ui/slider";
import { useStore } from "@/store";

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-xs text-zinc-400 uppercase tracking-wider font-semibold mb-1 block">
      {children}
    </label>
  );
}

export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
  resetValue = 0,
  trackGradient,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  display?: (v: number) => string;
  resetValue?: number;
  /** CSS gradient for the slider track background */
  trackGradient?: string;
}) {
  const setIsAdjustingFilter = useStore((s) => s.setIsAdjustingFilter);

  return (
    <div className="w-full">
      <div className="flex justify-between items-baseline mb-2">
        <span className="text-xs text-zinc-300">{label}</span>
        <span className="text-[10px] text-zinc-500 tabular-nums">
          {display ? display(value) : value.toFixed(2)}
        </span>
      </div>
      <div
        className="relative rounded"
        style={trackGradient ? { background: trackGradient, height: 4 } : undefined}
      >
        <Slider
          value={[value]}
          min={min}
          max={max}
          step={step}
          onValueChange={([v]) => onChange(v)}
          onPointerDown={() => setIsAdjustingFilter(true)}
          onPointerUp={() => setIsAdjustingFilter(false)}
          onPointerCancel={() => setIsAdjustingFilter(false)}
          onKeyDown={() => setIsAdjustingFilter(true)}
          onKeyUp={() => setIsAdjustingFilter(false)}
          onThumbDoubleClick={() => onChange(resetValue)}
          className={trackGradient ? "[&>span:first-child]:bg-transparent [&>span:first-child>span]:bg-transparent" : undefined}
        />
      </div>
    </div>
  );
}

export function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? "bg-blue-600" : "bg-zinc-700"}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : "translate-x-1"}`}
      />
    </button>
  );
}

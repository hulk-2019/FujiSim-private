import { Slider } from "@/components/ui/slider";

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
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  display?: (v: number) => string;
}) {
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="text-xs text-zinc-300">{label}</span>
        <span className="text-[10px] text-zinc-500 tabular-nums">
          {display ? display(value) : value.toFixed(2)}
        </span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
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

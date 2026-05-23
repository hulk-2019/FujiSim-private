import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function Section({ title, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-zinc-800/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-zinc-900/40 transition-colors"
      >
        <span className="text-xs uppercase tracking-wider text-zinc-300 font-semibold">{title}</span>
        <ChevronDown
          size={14}
          className={cn("text-zinc-500 transition-transform", open ? "rotate-0" : "-rotate-90")}
        />
      </button>
      {open && <div className="px-3 pb-4 space-y-4">{children}</div>}
    </div>
  );
}

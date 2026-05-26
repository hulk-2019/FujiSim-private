import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SectionProps {
  title: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function Section({ title, icon, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-zinc-900/40 transition-colors"
      >
        <span className="flex items-center gap-2 uppercase tracking-wider text-zinc-300 font-bold text-sm">
          {icon}
          {title}
        </span>
        <ChevronDown
          size={14}
          className={cn("text-zinc-500 transition-transform", open ? "rotate-0" : "-rotate-90")}
        />
      </button>
      {open && <div className="px-3 pb-4 space-y-4 pt-1">{children}</div>}
    </div>
  );
}

import { TabsTrigger } from "@/components/ui/tabs";

export function SideTabTrigger({
  value,
  label,
  icon,
}: {
  value: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <TabsTrigger
      value={value}
      aria-label={label}
      className="group relative h-9 w-full p-0 flex items-center justify-center"
    >
      {icon}
      <span
        role="tooltip"
        className="pointer-events-none absolute right-full mr-2 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md bg-zinc-900 text-zinc-100 text-xs px-2 py-1 shadow-lg border border-zinc-700/60 opacity-0 translate-x-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0 z-50"
      >
        {label}
      </span>
    </TabsTrigger>
  );
}

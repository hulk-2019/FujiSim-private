import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings as SettingsIcon, Database, RefreshCw, Info } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { GeneralTab } from "./tabs/GeneralTab";
import { CacheTab } from "./tabs/CacheTab";
import { AboutTab } from "./tabs/AboutTab";

type TabKey = "general" | "cache" | "update" | "about";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState<TabKey>("general");

  const tabs: Array<{ key: TabKey; icon: typeof SettingsIcon; label: string }> = [
    { key: "general", icon: SettingsIcon, label: t("settings.tabs.general") },
    { key: "cache", icon: Database, label: t("settings.tabs.cache") },
    { key: "update", icon: RefreshCw, label: t("settings.tabs.update") },
    { key: "about", icon: Info, label: t("settings.tabs.about") },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        <DialogTitle className="sr-only">{t("settings.title")}</DialogTitle>
        <div className="flex h-[520px]">
          <nav className="w-44 border-r border-zinc-800/60 bg-zinc-950/40 py-4 px-2 flex flex-col gap-1">
            {tabs.map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                onClick={() => setActive(key)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors text-left",
                  active === key
                    ? "bg-zinc-800/80 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
                )}
              >
                <Icon size={14} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="flex-1 p-6 overflow-y-auto">
            {active === "general" && <GeneralTab />}
            {active === "cache" && <CacheTab />}
            {active === "update" && <PlaceholderTab name="Update" />}
            {active === "about" && <AboutTab />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PlaceholderTab({ name }: { name: string }) {
  return <div className="text-sm text-zinc-400">{name} tab — coming up</div>;
}

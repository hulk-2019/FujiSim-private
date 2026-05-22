import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { open as openShell } from "@tauri-apps/plugin-shell";
import { Button } from "@/components/ui/button";

export function AboutTab() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion("unknown"));
  }, []);

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-zinc-800/60 flex items-center justify-center">
          <img
            src="/icon.png"
            alt="FujiSim"
            className="w-12 h-12"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">FujiSim</h2>
          <p className="text-sm text-zinc-400">
            {t("settings.about.version")} {version}
          </p>
        </div>
      </header>
      <dl className="space-y-3 text-sm">
        <div className="flex justify-between border-b border-zinc-800/60 pb-2">
          <dt className="text-zinc-400">{t("settings.about.website")}</dt>
          <dd>
            <Button
              variant="ghost"
              className="h-auto p-0 text-zinc-200"
              onClick={() => openShell(t("settings.about.websiteUrl"))}
            >
              {t("settings.about.websiteUrl")}
            </Button>
          </dd>
        </div>
        <div className="flex justify-between border-b border-zinc-800/60 pb-2">
          <dt className="text-zinc-400">{t("settings.about.license")}</dt>
          <dd className="text-zinc-200">{t("settings.about.licenseValue")}</dd>
        </div>
      </dl>
    </div>
  );
}

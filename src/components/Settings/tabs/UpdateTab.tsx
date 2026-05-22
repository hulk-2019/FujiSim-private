import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { Button } from "@/components/ui/button";
import { Label, ToggleSwitch } from "@/components/ui/form";
import { useSettings } from "@/hooks/use-settings";
import { useUpdater } from "@/hooks/use-updater";

export function UpdateTab() {
  const { t } = useTranslation();
  const { settings, update, loaded } = useSettings();
  const updater = useUpdater();
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  const lastCheckLabel =
    settings.updateLastCheck === ""
      ? t("settings.update.lastCheckNever")
      : new Date(settings.updateLastCheck).toLocaleString();

  function renderActionButton() {
    switch (updater.state.kind) {
      case "checking":
        return <Button disabled>{t("settings.update.states.checking")}</Button>;
      case "available":
        return (
          <Button onClick={updater.downloadAndInstall}>
            {t("settings.update.actions.download")}
          </Button>
        );
      case "downloading":
        return (
          <Button disabled>
            {t("settings.update.states.downloading", { progress: updater.state.progress })}
          </Button>
        );
      case "ready":
        return (
          <Button onClick={updater.restart}>
            {t("settings.update.actions.install")}
          </Button>
        );
      default:
        return (
          <Button onClick={() => updater.checkForUpdates(false)}>
            {t("settings.update.checkNow")}
          </Button>
        );
    }
  }

  if (!loaded) {
    return <div className="text-sm text-zinc-500">…</div>;
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex justify-between items-center">
          <span className="text-sm text-zinc-400">{t("settings.update.currentVersion")}</span>
          <span className="text-sm text-zinc-200">{version || "?"}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-zinc-400">{t("settings.update.lastCheck")}</span>
          <span className="text-sm text-zinc-200">{lastCheckLabel}</span>
        </div>
        <div className="pt-2">{renderActionButton()}</div>
        {updater.state.kind === "up-to-date" && (
          <p className="text-xs text-emerald-400">{t("settings.update.states.upToDate")}</p>
        )}
        {updater.state.kind === "error" && (
          <p className="text-xs text-red-400">
            {t("settings.update.states.error", { message: updater.state.message })}
          </p>
        )}
      </section>

      <section className="space-y-3 border-t border-zinc-800/60 pt-4">
        <div className="flex items-center justify-between">
          <Label>{t("settings.update.autoCheck")}</Label>
          <ToggleSwitch
            checked={settings.updateAutoCheck}
            onChange={(v) => update("updateAutoCheck", v)}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label>{t("settings.update.confirmInstall")}</Label>
          <ToggleSwitch
            checked={settings.updateConfirmInstall}
            onChange={(v) => update("updateConfirmInstall", v)}
          />
        </div>
      </section>

      <section className="space-y-2 border-t border-zinc-800/60 pt-4">
        <Label>{t("settings.update.skippedVersions")}</Label>
        {settings.updateSkippedVersions.length === 0 ? (
          <p className="text-xs text-zinc-500">{t("settings.update.noSkipped")}</p>
        ) : (
          <ul className="space-y-1">
            {settings.updateSkippedVersions.map((v) => (
              <li key={v} className="flex items-center justify-between text-sm">
                <span className="text-zinc-300">{v}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    updater.cancelSkip(v);
                    update(
                      "updateSkippedVersions",
                      settings.updateSkippedVersions.filter((x) => x !== v)
                    );
                  }}
                >
                  {t("settings.update.cancelSkip")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

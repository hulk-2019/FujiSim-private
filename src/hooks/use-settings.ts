import { useCallback, useEffect, useState } from "react";
import { api } from "@/api";

export type Theme = "light" | "dark";
export type Language = "zh" | "en";

export interface Settings {
  theme: Theme;
  language: Language;
  updateAutoCheck: boolean;
  updateConfirmInstall: boolean;
  updateSkippedVersions: string[];
  updateLastCheck: string;
}

const DEFAULTS: Settings = {
  theme: "light",
  language: "zh",
  updateAutoCheck: true,
  updateConfirmInstall: true,
  updateSkippedVersions: [],
  updateLastCheck: "",
};

const KEYS = {
  theme: "ui.theme",
  language: "ui.language",
  updateAutoCheck: "update.auto_check",
  updateConfirmInstall: "update.confirm_install",
  updateSkippedVersions: "update.skipped_versions",
  updateLastCheck: "update.last_check",
} as const;

function parseValue<T>(raw: string | undefined, fallback: T): T {
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseSettings(kv: Record<string, string>): Settings {
  return {
    theme: parseValue<Theme>(kv[KEYS.theme], DEFAULTS.theme),
    language: parseValue<Language>(kv[KEYS.language], DEFAULTS.language),
    updateAutoCheck: parseValue<boolean>(kv[KEYS.updateAutoCheck], DEFAULTS.updateAutoCheck),
    updateConfirmInstall: parseValue<boolean>(kv[KEYS.updateConfirmInstall], DEFAULTS.updateConfirmInstall),
    updateSkippedVersions: parseValue<string[]>(kv[KEYS.updateSkippedVersions], DEFAULTS.updateSkippedVersions),
    updateLastCheck: parseValue<string>(kv[KEYS.updateLastCheck], DEFAULTS.updateLastCheck),
  };
}

export function useSettings() {
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    api
      .getAllSettings()
      .then((kv) => {
        if (cancelled) return;
        setSettings(parseSettings(kv));
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(
    async <K extends keyof Settings>(key: K, value: Settings[K]) => {
      await api.setSetting(KEYS[key], JSON.stringify(value));
      setSettings((s) => ({ ...s, [key]: value }));
    },
    []
  );

  return { settings, update, loaded };
}

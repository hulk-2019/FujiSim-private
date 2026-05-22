import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { useSettings, type Theme, type Language } from "@/hooks/use-settings";
import { Label } from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function GeneralTab() {
  const { t } = useTranslation();
  const { settings, update, loaded } = useSettings();

  useEffect(() => {
    if (!loaded) return;
    if (settings.theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [settings.theme, loaded]);

  useEffect(() => {
    if (!loaded) return;
    if (i18n.language !== settings.language) {
      i18n.changeLanguage(settings.language);
    }
  }, [settings.language, loaded]);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <Label>{t("settings.general.theme")}</Label>
        <Select
          value={settings.theme}
          onValueChange={(v) => update("theme", v as Theme)}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">{t("settings.general.themeLight")}</SelectItem>
            <SelectItem value="dark">{t("settings.general.themeDark")}</SelectItem>
          </SelectContent>
        </Select>
      </section>
      <section className="space-y-2">
        <Label>{t("settings.general.language")}</Label>
        <Select
          value={settings.language}
          onValueChange={(v) => update("language", v as Language)}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh">{t("settings.general.chinese")}</SelectItem>
            <SelectItem value="en">{t("settings.general.english")}</SelectItem>
          </SelectContent>
        </Select>
      </section>
    </div>
  );
}

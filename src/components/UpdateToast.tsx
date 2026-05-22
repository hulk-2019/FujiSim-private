import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { UpdateState } from "@/hooks/use-updater";

interface UpdateToastProps {
  state: UpdateState;
  onDownload: () => void;
  onRestart: () => void;
  onSkip: () => void;
  onDismiss: () => void;
  silent: boolean;
}

export function UpdateToast({
  state,
  onDownload,
  onRestart,
  onSkip,
  onDismiss,
  silent,
}: UpdateToastProps) {
  const { t } = useTranslation();

  const visible =
    state.kind === "available" ||
    state.kind === "downloading" ||
    state.kind === "ready" ||
    (!silent && state.kind === "error");

  if (!visible) return null;

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[9999] w-[360px] max-w-[90vw] rounded-xl border border-zinc-800/80 bg-zinc-900/95 backdrop-blur-md shadow-2xl p-4 text-zinc-100">
      {state.kind === "available" && (
        <>
          <h3 className="text-sm font-medium">
            {t("settings.update.states.available", { version: state.version })}
          </h3>
          {state.notes && (
            <p className="mt-1 text-xs text-zinc-400 line-clamp-3">{state.notes}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={onSkip}>
              {t("settings.update.actions.skip")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              {t("settings.update.actions.later")}
            </Button>
            <Button size="sm" onClick={onDownload}>
              {t("settings.update.actions.download")}
            </Button>
          </div>
        </>
      )}

      {state.kind === "downloading" && (
        <>
          <h3 className="text-sm font-medium">
            {t("settings.update.states.downloading", { progress: state.progress })}
          </h3>
          <div className="mt-3 h-1 w-full overflow-hidden rounded bg-zinc-800">
            <div
              className="h-full bg-zinc-200 transition-all"
              style={{ width: `${state.progress}%` }}
            />
          </div>
        </>
      )}

      {state.kind === "ready" && (
        <>
          <h3 className="text-sm font-medium">{t("settings.update.states.ready")}</h3>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              {t("settings.update.actions.later")}
            </Button>
            <Button size="sm" onClick={onRestart}>
              {t("settings.update.actions.install")}
            </Button>
          </div>
        </>
      )}

      {state.kind === "error" && (
        <h3 className="text-sm font-medium text-red-400">
          {t("settings.update.states.error", { message: state.message })}
        </h3>
      )}
    </div>
  );
}

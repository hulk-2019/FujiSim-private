import { useEffect } from "react";
import { useUpdater } from "@/hooks/use-updater";
import { UpdateToast } from "@/components/UpdateToast";

export function UpdaterBootstrap() {
  const updater = useUpdater();

  useEffect(() => {
    const t = setTimeout(() => {
      updater.checkForUpdates(true);
    }, 3000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <UpdateToast
      state={updater.state}
      onDownload={updater.downloadAndInstall}
      onRestart={updater.restart}
      onSkip={() => {
        if (updater.state.kind === "available") {
          updater.skipVersion(updater.state.version);
        }
      }}
      onDismiss={updater.dismiss}
      silent={true}
    />
  );
}

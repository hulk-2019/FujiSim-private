import { useCallback, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api } from "@/api";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "up-to-date" }
  | { kind: "error"; message: string };

const SKIPPED_KEY = "update.skipped_versions";
const LAST_CHECK_KEY = "update.last_check";

export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);

  const checkForUpdates = useCallback(async (silent = false) => {
    setState({ kind: "checking" });
    try {
      await api.setSetting(LAST_CHECK_KEY, JSON.stringify(new Date().toISOString()));
      const update = await check();
      if (!update) {
        setState({ kind: "up-to-date" });
        return;
      }

      if (silent) {
        const skippedRaw = await api.getSetting(SKIPPED_KEY);
        const skipped: string[] = skippedRaw ? JSON.parse(skippedRaw) : [];
        if (skipped.includes(update.version)) {
          setState({ kind: "idle" });
          return;
        }
      }

      setPendingUpdate(update);
      setState({
        kind: "available",
        version: update.version,
        notes: update.body ?? "",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({ kind: "error", message });
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (!pendingUpdate) return;
    setState({ kind: "downloading", progress: 0 });
    try {
      let downloaded = 0;
      let total = 0;
      await pendingUpdate.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (total > 0) {
              setState({
                kind: "downloading",
                progress: Math.min(99, Math.round((downloaded / total) * 100)),
              });
            }
            break;
          case "Finished":
            setState({ kind: "ready" });
            break;
        }
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({ kind: "error", message });
    }
  }, [pendingUpdate]);

  const restart = useCallback(async () => {
    await relaunch();
  }, []);

  const skipVersion = useCallback(async (version: string) => {
    const raw = await api.getSetting(SKIPPED_KEY);
    const skipped: string[] = raw ? JSON.parse(raw) : [];
    if (!skipped.includes(version)) {
      skipped.push(version);
      await api.setSetting(SKIPPED_KEY, JSON.stringify(skipped));
    }
    setState({ kind: "idle" });
  }, []);

  const cancelSkip = useCallback(async (version: string) => {
    const raw = await api.getSetting(SKIPPED_KEY);
    const skipped: string[] = raw ? JSON.parse(raw) : [];
    const next = skipped.filter((v) => v !== version);
    await api.setSetting(SKIPPED_KEY, JSON.stringify(next));
  }, []);

  const dismiss = useCallback(() => {
    setState({ kind: "idle" });
  }, []);

  return {
    state,
    checkForUpdates,
    downloadAndInstall,
    restart,
    skipVersion,
    cancelSkip,
    dismiss,
  };
}

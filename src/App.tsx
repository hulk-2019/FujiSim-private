import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { NavSidebar } from "@/components/NavSidebar";
import { TitleBar } from "@/components/TitleBar";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { EditorPage } from "@/pages/EditorPage";
import { TrashPage } from "@/pages/TrashPage";
import { Toaster } from "@/components/ui/toast";
import { UpdaterBootstrap } from "@/components/UpdaterBootstrap";
import { useStore } from "@/store";
import { api, type BatchProgress } from "@/api";

function HomeLayout() {
  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      <NavSidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}

export default function App() {
  useEffect(() => {
    api.getSetting("ui.theme").then((raw) => {
      if (raw && JSON.parse(raw) === "dark") {
        document.documentElement.classList.add("dark");
      }
    }).catch(() => {});
    api.getSetting("ui.language").then((raw) => {
      if (raw) {
        const lang = JSON.parse(raw);
        if (lang === "en" || lang === "zh") {
          import("@/i18n").then(({ default: i18n }) => i18n.changeLanguage(lang));
        }
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const { refreshAssets, refreshFacets, refreshPresets, refreshUserLuts,
            refreshProjects, refreshProjectSummaries, refreshCategories, setCoverDir } = useStore.getState();
    refreshAssets();
    refreshFacets();
    refreshPresets();
    refreshCategories();
    refreshUserLuts();
    refreshProjects();
    refreshProjectSummaries();
    api.getCoverDir().then(setCoverDir).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen<BatchProgress>("export:progress", (e) => {
      useStore.getState().setProgress(e.payload);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const pendingIds = new Set<number>();
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    listen<{ asset_id: number }>("thumbnail:done", (e) => {
      if (cancelled) return;
      pendingIds.add(e.payload.asset_id);
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = setTimeout(async () => {
        if (cancelled) return;
        const ids = [...pendingIds];
        pendingIds.clear();
        const updates = await Promise.all(ids.map((id) => api.getAsset(id).catch(() => null)));
        const valid = updates.filter((a): a is NonNullable<typeof a> => a !== null);
        if (valid.length > 0) useStore.getState().batchPatchAssets(valid);
      }, 200);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      if (batchTimer) clearTimeout(batchTimer);
      unlisten?.();
    };
  }, []);

  return (
    <BrowserRouter>
      <div className="h-full w-full flex flex-col bg-zinc-950 text-zinc-200">
        <TitleBar />
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route element={<HomeLayout />}>
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/trash" element={<TrashPage />} />
          </Route>
          <Route path="/projects/:folderId" element={<EditorPage />} />
        </Routes>
      </div>
      <Toaster />
      <UpdaterBootstrap />
    </BrowserRouter>
  );
}

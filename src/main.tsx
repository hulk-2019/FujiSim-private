import ReactDOM from "react-dom/client";
import App from "./App";
// @ts-ignore
import "./index.css";
import "./i18n";
import { loadPersistedFonts } from "./lib/fontManager";
import { useStore } from "./store";
import { api } from "./api";

const initialTheme = localStorage.getItem("fujisim-theme") || "light";
if (initialTheme === "dark") {
  document.documentElement.classList.add("dark");
} else {
  document.documentElement.classList.remove("dark");
}

const loadFonts = () =>
  loadPersistedFonts().then((fonts) => {
    if (fonts.length > 0) useStore.setState({ userFonts: fonts });
  });

if (typeof requestIdleCallback !== "undefined") {
  requestIdleCallback(loadFonts);
} else {
  setTimeout(loadFonts, 500);
}

useStore.getState().refreshWatermarkPresets();

// 启动时从 SQLite 加载 pending / processing / cancelled / error 任务，
// 并通过任务队列恢复 pending 任务的执行。
api.listActiveTasksOnStartup().then(async (tasks) => {
  if (tasks.length === 0) return;

  const exportTasks = new Map(
    tasks.map((t) => [
      t.id,
      {
        task_id: t.id,
        total: t.total,
        completed: t.completed,
        failed: t.failed,
        // done 仅在终态（done/error/cancelled）时为 true
        done: t.status === "done" || t.status === "error" || t.status === "cancelled",
        last_asset_id: null,
        last_output: null,
        last_error: null,
      },
    ])
  );
  const taskDetails = new Map(tasks.map((t) => [t.id, t]));
  useStore.setState({ exportTasks, taskDetails });

  // 只对 pending 任务发起重试（processing 已在 db/mod.rs 迁移时重置为 pending）
  const pendingTasks = tasks.filter((t) => t.status === "pending");
  for (const task of pendingTasks) {
    await useStore.getState().retryExportTask(task.id).catch(() => {});
  }
}).catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <App />
);

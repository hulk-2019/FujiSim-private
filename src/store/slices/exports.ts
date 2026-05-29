import type { StateCreator } from "zustand";
import { api } from "../../api";
import type { AppState, ExportSlice } from "../types";

export const createExportSlice: StateCreator<AppState, [], [], ExportSlice> = (set, get) => ({
  importing: false,
  lastImport: null,
  exportTasks: new Map(),
  taskDetails: new Map(),
  dismissedTaskIds: new Set(),
  progress: null,

  setProgress: (p) => {
    if (!p) return;
    const nextTasks = new Map(get().exportTasks);
    nextTasks.set(p.task_id, p);

    const details = get().taskDetails;
    const detail = details.get(p.task_id);

    if (p.done && detail) {
      const finalStatus = p.failed > 0 ? "error" : "done";
      const nextDetails = new Map(details);
      nextDetails.set(p.task_id, { ...detail, status: finalStatus });
      set({ exportTasks: nextTasks, progress: p, taskDetails: nextDetails });
      return;
    }

    set({ exportTasks: nextTasks, progress: p });

    // 收到进度事件但 UI 状态不是 processing → 从 DB 拉取最新 status
    if (!p.done && detail?.status !== "processing") {
      api.getTask(p.task_id).then((t) => {
        if (!t) return;
        const cur = get().taskDetails;
        const nextDetails = new Map(cur);
        nextDetails.set(t.id, t);
        set({ taskDetails: nextDetails });
      }).catch(() => {});
    }
  },
  setImporting: (flag, last) =>
    set({ importing: flag, lastImport: last ?? get().lastImport }),
  // 删除单个任务：先取消（DB 状态→cancelled，停止 rayon 工作线程），再软删除
  dismissExportTask: async (taskId) => {
    await api.cancelExportTask(taskId).catch(() => {});
    await api.deleteExportTask(taskId).catch(() => {});
    set({ dismissedTaskIds: new Set([...get().dismissedTaskIds, taskId]) });
  },
  // 取消任务：状态变为 cancelled，UI 仍然可见（让用户可以看到/重试）
  cancelExportTask: async (taskId) => {
    await api.cancelExportTask(taskId).catch(() => {});
    const details = get().taskDetails;
    const detail = details.get(taskId);
    if (detail) {
      set({ taskDetails: new Map(details).set(taskId, { ...detail, status: "cancelled" }) });
    }
  },
  // 一键清空：所有任务取消并软删除（DB + UI）
  clearCompletedExportTasks: async () => {
    const { exportTasks, dismissedTaskIds } = get();
    const allIds = [...exportTasks.values()]
      .filter((t) => !dismissedTaskIds.has(t.task_id))
      .map((t) => t.task_id);
    if (allIds.length === 0) return;
    await api.deleteAllExportTasks(allIds).catch(() => {});
    set({ dismissedTaskIds: new Set([...dismissedTaskIds, ...allIds]) });
  },
  // 重试：复用原 task_id，后端从 DB 恢复水印设置，无需前端重新渲染
  retryExportTask: async (taskId) => {
    try {
      await api.retryExportTask(taskId);

      const next = new Set(get().dismissedTaskIds);
      next.delete(taskId);
      const detail = get().taskDetails.get(taskId);
      if (detail) {
        set({
          dismissedTaskIds: next,
          taskDetails: new Map(get().taskDetails).set(taskId, { ...detail, status: "pending" }),
        });
      } else {
        set({ dismissedTaskIds: next });
      }
    } catch (e) {
      console.error("retryExportTask failed", e);
    }
  },
});

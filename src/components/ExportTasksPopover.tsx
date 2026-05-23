import { useState, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "@/store";
import { Download, X, CheckCircle, AlertCircle, Loader2, RotateCcw, CirclePause, Clock, Ban, Bell } from "lucide-react";
import { cn, getTaskStatus, TASK_STATUS_COLOR, formatTime } from "@/lib/utils";
import type { BatchProgress, BatchTask } from "@/types";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import type { TaskStatus } from "@/lib/utils";

const STATUS_ICON: Record<TaskStatus, React.ReactNode> = {
  pending:    <Clock size={12} className="text-amber-400 shrink-0" />,
  processing: <Loader2 size={12} className="text-blue-400 shrink-0 animate-spin" />,
  done:       <CheckCircle size={12} className="text-emerald-400 shrink-0" />,
  error:      <AlertCircle size={12} className="text-red-400 shrink-0" />,
  cancelled:  <Ban size={12} className="text-zinc-400 shrink-0" />,
};

function TaskRow({
  progress,
  detail,
  onDismiss,
  onCancel,
  onRetry,
}: {
  progress: BatchProgress;
  detail?: BatchTask;
  onDismiss: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const status = getTaskStatus(progress, detail?.status);
  const done = status === "done" || status === "error" || status === "cancelled";
  const pct =
    progress.total > 0
      ? Math.round(((progress.completed + progress.failed) / progress.total) * 100)
      : 0;

  let format = "";
  if (detail?.export_settings_json) {
    try { format = (JSON.parse(detail.export_settings_json).format ?? "").toUpperCase(); } catch {}
  }
  let hasWatermark = false;
  if (detail?.watermark_json) {
    try { hasWatermark = JSON.parse(detail.watermark_json).enabled === true; } catch {}
  }

  return (
    <div className="space-y-1.5 py-2.5 border-b border-zinc-800/60 last:border-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {STATUS_ICON[status]}
          <span className="text-xs text-zinc-100 font-medium">#{progress.task_id}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {(status === "processing" || status === "pending") && (
            <button type="button" onClick={onCancel} title={t("exportTasks.stopTask")}
              className="text-zinc-600 hover:text-red-400">
              <CirclePause size={12} />
            </button>
          )}
          {(status === "error" || status === "cancelled") && (
            <button type="button" onClick={onRetry} title={t("common.retry")}
              className="text-zinc-600 hover:text-blue-400">
              <RotateCcw size={11} />
            </button>
          )}
          {done && (
            <button type="button" onClick={onDismiss} title={t("common.close")}
              className="text-zinc-600 hover:text-zinc-300">
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      <div
        className={cn(
          "h-1 w-full rounded-full overflow-hidden",
          status === "error"      ? "bg-red-100 dark:bg-red-950/50" :
          status === "done"       ? "bg-emerald-100 dark:bg-emerald-950/50" :
          status === "processing" ? "bg-blue-100 dark:bg-blue-950/50" :
          status === "pending"    ? "bg-amber-100 dark:bg-amber-950/50" : "bg-zinc-800"
        )}
      >
        <div
          className={cn(
            "h-full rounded-full transition-all duration-200",
            status === "error"      ? "bg-red-500" :
            status === "done"       ? "bg-emerald-500" :
            status === "processing" ? "bg-blue-400 dark:bg-blue-500" :
            status === "pending"    ? "bg-amber-500" : "bg-zinc-700"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-[10px] text-zinc-600">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={cn("text-[10px] px-1.5 py-0 rounded font-medium", TASK_STATUS_COLOR[status])}>
            {t(`taskStatus.${status}`)}
          </span>
          {format && (
            <span className={cn("text-[10px] px-1 rounded", TASK_STATUS_COLOR[status])}>{format}</span>
          )}
          {hasWatermark && (
            <span className={cn("text-[10px] px-1 rounded", TASK_STATUS_COLOR[status])}>
              {t("exportTasks.watermarkBadge")}
            </span>
          )}
        </div>
        {detail?.created_at && <span>{formatTime(detail.created_at)}</span>}
      </div>

      {progress.last_error && (
        <p className="text-[10px] text-red-400 truncate">{progress.last_error}</p>
      )}
    </div>
  );
}

export function ExportTasksPopover() {
  const { t } = useTranslation();
  const exportTasks = useStore((s) => s.exportTasks);
  const taskDetails = useStore((s) => s.taskDetails);
  const dismissedTaskIds = useStore((s) => s.dismissedTaskIds);
  const dismissExportTask = useStore((s) => s.dismissExportTask);
  const cancelExportTask = useStore((s) => s.cancelExportTask);
  const clearCompletedExportTasks = useStore((s) => s.clearCompletedExportTasks);
  const retryExportTask = useStore((s) => s.retryExportTask);

  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const STATUS_PRIORITY: Record<string, number> = {
    processing: 0,
    pending: 1,
    error: 2,
    cancelled: 3,
    done: 4,
  };

  const tasks = [...exportTasks.values()]
    .filter((t) => !dismissedTaskIds.has(t.task_id))
    .sort((a, b) => {
      const sa = getTaskStatus(a, taskDetails.get(a.task_id)?.status);
      const sb = getTaskStatus(b, taskDetails.get(b.task_id)?.status);
      const pa = STATUS_PRIORITY[sa] ?? 9;
      const pb = STATUS_PRIORITY[sb] ?? 9;
      if (pa !== pb) return pa - pb;
      return b.task_id - a.task_id;
    });

  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 80,
    overscan: 3,
  });

  const activeCount = tasks.filter((t) => {
    const s = getTaskStatus(t, taskDetails.get(t.task_id)?.status);
    return s === "pending" || s === "processing";
  }).length;

  const completedCount = tasks.filter((t) => {
    const s = getTaskStatus(t, taskDetails.get(t.task_id)?.status);
    return s === "done" || s === "error" || s === "cancelled";
  }).length;

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative h-8 w-8 flex-shrink-0 text-zinc-400",
          activeCount > 0 && "text-blue-400 hover:text-blue-300"
        )}
        title={t("exportTasks.title")}
      >
        <Bell size={14} />
        {activeCount > 0 && (
          <span className="absolute -top-1 -right-1 h-3.5 w-3.5 rounded-full bg-blue-500 text-[9px] text-white flex items-center justify-center font-bold leading-none ring-2 ring-zinc-950">
            {activeCount}
          </span>
        )}
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 w-72 rounded-lg bg-white dark:bg-zinc-900 shadow-xl z-50">
            <div className="px-3 pt-2.5 pb-1.5 border-b border-zinc-800/60 flex items-center justify-between">
              <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">
                {t("exportTasks.title")}
              </p>
              <div className="flex items-center gap-2">
                {activeCount > 0 && (
                  <span className="text-[10px] text-blue-400">
                    {t("exportTasks.inProgress", { count: activeCount })}
                  </span>
                )}
                {completedCount > 0 && (
                  <button type="button" onClick={clearCompletedExportTasks}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300">
                    {t("exportTasks.clearCompleted")}
                  </button>
                )}
              </div>
            </div>
            <div ref={listRef} className="px-3 max-h-80 overflow-y-auto">
              {tasks.length === 0 ? (
                <p className="py-4 text-center text-xs text-zinc-600">{t("exportTasks.empty")}</p>
              ) : (
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                  {virtualizer.getVirtualItems().map((vItem) => {
                    const task = tasks[vItem.index];
                    return (
                      <div
                        key={task.task_id}
                        style={{ position: "absolute", top: vItem.start, left: 0, right: 0 }}
                        ref={virtualizer.measureElement}
                        data-index={vItem.index}
                      >
                        <TaskRow
                          progress={task}
                          detail={taskDetails.get(task.task_id)}
                          onDismiss={() => dismissExportTask(task.task_id)}
                          onCancel={() => cancelExportTask(task.task_id)}
                          onRetry={() => retryExportTask(task.task_id)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

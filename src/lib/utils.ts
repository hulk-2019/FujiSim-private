import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { BatchProgress } from "@/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(n?: number | null) {
  if (!n && n !== 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function shortDate(s?: string | null) {
  if (!s) return "—";
  return s.replace("T", " ").slice(0, 16);
}

export function formatTime(iso: string) {
  try {
    return new Date(iso.replace(" ", "T")).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** 把 Uint8Array 转成 base64 字符串，分块处理避免栈溢出 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

export type TaskStatus = "pending" | "processing" | "cancelled" | "done" | "error";

/** DB status 为权威来源；无 DB 记录时从进度事件推断（仅用于新任务尚未写入 taskDetails 的瞬间） */
export function getTaskStatus(p: BatchProgress, dbStatus?: string): TaskStatus {
  if (dbStatus === "pending")    return "pending";
  if (dbStatus === "cancelled")  return "cancelled";
  if (dbStatus === "done")       return "done";
  if (dbStatus === "error")      return "error";
  if (dbStatus === "processing") return "processing";
  // 无 DB 记录时回退：仅用于 start_batch_export 推送第一条事件但 taskDetails 尚未写入的极短窗口
  if (p.done) return p.failed > 0 ? "error" : "done";
  return "pending";
}

export const TASK_STATUS_COLOR: Record<TaskStatus, string> = {
  pending:    "text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-950/50",
  processing: "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-950/50",
  done:       "text-emerald-600 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-950/50",
  error:      "text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-950/50",
  cancelled:  "text-zinc-500 bg-zinc-800",
};

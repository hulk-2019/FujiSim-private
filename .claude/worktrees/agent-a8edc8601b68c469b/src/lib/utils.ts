import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 Tailwind className 的助手。
 *
 * 同时具备 `clsx` 的条件拼接能力（`cn("a", cond && "b")`）和 `tailwind-merge`
 * 的冲突消解（`cn("p-2", "p-4")` → `"p-4"`，后者生效），是 shadcn 生态的事实标准。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 人类友好的字节数格式化：1024 → "1.0 KB"，1_500_000 → "1.4 MB"。
 * `null` / `undefined` 一律显示为长破折号 "—"，避免 UI 上出现 "undefined B"。
 */
export function formatBytes(n?: number | null) {
  if (!n && n !== 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 把 Exif 风格的时间字符串（"2024-05-11 14:30:22"）截断到分钟精度，用于网格/列表展示。
 * 对于空值/ISO 形式（含 T）也能兼容。
 */
export function shortDate(s?: string | null) {
  if (!s) return "—";
  return s.replace("T", " ").slice(0, 16);
}

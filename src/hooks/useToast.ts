import { useState, useCallback } from "react";

export type ToastVariant = "default" | "success" | "error" | "warning";

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  duration?: number;
}

type ToastInput = Omit<ToastItem, "id" | "variant">;

let _dispatch: ((item: ToastItem) => void) | null = null;

function emit(variant: ToastVariant, title: string, opts?: Omit<ToastInput, "title">) {
  _dispatch?.({ id: Math.random().toString(36).slice(2), variant, title, ...opts });
}

export const toast = {
  default: (title: string, opts?: Omit<ToastInput, "title">) => emit("default", title, opts),
  success: (title: string, opts?: Omit<ToastInput, "title">) => emit("success", title, opts),
  error:   (title: string, opts?: Omit<ToastInput, "title">) => emit("error",   title, opts),
  warning: (title: string, opts?: Omit<ToastInput, "title">) => emit("warning", title, opts),
};

export function useToastStore() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const register = useCallback((dispatch: (item: ToastItem) => void) => {
    _dispatch = dispatch;
    return () => { _dispatch = null; };
  }, []);

  const add = useCallback((item: ToastItem) => {
    setToasts((prev) => [...prev, item]);
  }, []);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, register, add, remove };
}

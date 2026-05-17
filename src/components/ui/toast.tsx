import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToastStore } from "@/hooks/useToast";

const variantStyles: Record<string, string> = {
  default: "bg-zinc-900/80 border-zinc-800 text-zinc-100",
  success: "bg-emerald-950/80 border-emerald-800/50 text-emerald-100",
  error:   "bg-red-950/80 border-red-800/50 text-red-100",
  warning: "bg-amber-950/80 border-amber-800/50 text-amber-100",
};

const titleColor: Record<string, string> = {
  default: "text-zinc-100",
  success: "text-emerald-300",
  error:   "text-red-300",
  warning: "text-amber-300",
};

export function Toaster() {
  const { toasts, register, add, remove } = useToastStore();

  React.useEffect(() => register(add), [register, add]);

  return (
    <ToastPrimitive.Provider swipeDirection="up">
      {toasts.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          duration={t.duration ?? 3500}
          onOpenChange={(open) => { if (!open) remove(t.id); }}
          className={cn(
            "group pointer-events-auto relative flex w-auto min-w-[300px] max-w-md items-center gap-3 overflow-hidden rounded-full border px-5 py-3 shadow-2xl backdrop-blur-md",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:slide-in-from-top-full data-[state=closed]:slide-out-to-top-full",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "transition-all duration-300 ease-out",
            variantStyles[t.variant],
          )}
        >
          <div className="flex-1 min-w-0 flex flex-col justify-center">
            <ToastPrimitive.Title className={cn("text-sm font-medium leading-snug", titleColor[t.variant])}>
              {t.title}
            </ToastPrimitive.Title>
            {t.description && (
              <ToastPrimitive.Description className="mt-0.5 text-xs opacity-80 leading-snug">
                {t.description}
              </ToastPrimitive.Description>
            )}
          </div>
          <ToastPrimitive.Close className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity flex items-center justify-center">
            <X size={16} />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}

      <ToastPrimitive.Viewport className="fixed top-6 left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  );
}

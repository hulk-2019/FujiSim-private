import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon, Eye, EyeOff } from "lucide-react";
import { api } from "@/api";
import type { PreviewResult } from "@/types";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { formatBytes, shortDate } from "@/lib/utils";

export function PreviewPanel({ onExport }: { onExport: () => void }) {
  const focusedId = useStore((s) => s.focusedId);
  const assets = useStore((s) => s.assets);
  const filter = useStore((s) => s.filter);
  const focused = assets.find((a) => a.id === focusedId) ?? null;

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    if (!focused) {
      setPreview(null);
      return;
    }
    if (focused.is_raw) {
      setPreview(null);
      setError("RAW 预览暂未启用（MVP 阶段）。已支持 JPEG/PNG/TIFF/HEIF。");
      return;
    }
    setError(null);
    const myId = ++reqId.current;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const r = await api.getPreview(focused.id, filter, 1280);
        if (reqId.current === myId) {
          setPreview(r);
          setLoading(false);
        }
      } catch (e) {
        if (reqId.current === myId) {
          setError(String(e));
          setLoading(false);
        }
      }
    }, 80);
    return () => clearTimeout(handle);
  }, [focused?.id, focused?.is_raw, filter]);

  if (!focused) {
    return (
      <main className="w-full h-full flex items-center justify-center text-zinc-600 bg-transparent">
        <div className="flex flex-col items-center gap-2 text-sm">
          <ImageIcon size={40} />
          <span>从左侧选择一张照片</span>
        </div>
      </main>
    );
  }

  const previewSrc = preview ? `data:${preview.mime};base64,${preview.data}` : null;
  const originalSrc = !focused.is_raw ? convertFileSrc(focused.file_path) : null;

  return (
    <main className="w-full h-full flex flex-col bg-transparent min-w-0">
      <div className="border-b border-zinc-800/60 px-4 py-2 flex items-center gap-3 text-xs bg-zinc-950/40">
        <div className="flex-1 min-w-0">
          <p className="text-zinc-100 truncate text-sm">{focused.file_name}</p>
          <p className="text-zinc-500 truncate">
            {focused.camera_model ?? "—"} · {focused.lens_model ?? "—"}
            {focused.iso != null && ` · ISO ${focused.iso}`}
            {focused.f_number != null && ` · f/${focused.f_number.toFixed(1)}`}
            {focused.shutter_speed && ` · ${focused.shutter_speed}s`}
            {focused.focal_length != null && ` · ${focused.focal_length.toFixed(0)}mm`}
            {` · ${shortDate(focused.date_taken)}`}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onMouseDown={() => setShowOriginal(true)}
          onMouseUp={() => setShowOriginal(false)}
          onMouseLeave={() => setShowOriginal(false)}
          disabled={focused.is_raw === 1}
        >
          {showOriginal ? <EyeOff size={12} /> : <Eye size={12} />} 按住看原图
        </Button>
        <Button onClick={onExport} size="sm">
          导出
        </Button>
      </div>
      <div className="flex-1 relative overflow-hidden flex items-center justify-center p-4 bg-zinc-950/20">
        {error ? (
          <div className="text-zinc-400 text-sm bg-zinc-900/80 px-4 py-2 rounded border border-zinc-800">
            {error}
          </div>
        ) : (
          <>
            {showOriginal && originalSrc && (
              <img
                src={originalSrc}
                alt="original"
                className="max-w-full max-h-full object-contain shadow-2xl no-drag"
              />
            )}
            {!showOriginal && previewSrc && (
              <img
                src={previewSrc}
                alt="preview"
                className="max-w-full max-h-full object-contain shadow-2xl no-drag"
              />
            )}
            {loading && (
              <div className="absolute top-3 left-3 text-xs text-zinc-400 bg-zinc-950/60 px-2 py-1 rounded">
                渲染中...
              </div>
            )}
            {preview && (
              <div className="absolute bottom-3 right-3 text-[10px] text-zinc-500 bg-zinc-950/60 px-2 py-1 rounded">
                {preview.width} × {preview.height} · {formatBytes(focused.file_size)}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

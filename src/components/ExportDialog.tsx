import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStore } from "@/store";
import { api } from "@/api";
import type {
  Destination,
  ExportFormat,
  ExportSettings,
  ResizeSpec,
} from "@/types";
import { renderWatermarkLayer } from "@/lib/watermarkCanvas";
import { useTranslation } from "react-i18next";

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (b: boolean) => void;
}

const LOSSY_FORMATS: ExportFormat[] = ["jpeg", "webp"];

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const { t } = useTranslation();
  const filter = useStore((s) => s.filter);
  const selectedIds = useStore((s) => s.selectedIds);
  const focusedId = useStore((s) => s.focusedId);
  const assets = useStore((s) => s.assets);
  const watermark = useStore((s) => s.watermark);
  const focusedAsset = assets.find((a) => a?.id === focusedId) ?? null;
  const [format, setFormat] = useState<ExportFormat>("jpeg");
  const [quality, setQuality] = useState(92);
  const [destKind, setDestKind] = useState<"subfolder" | "path">("subfolder");
  const [subfolder, setSubfolder] = useState("FujiSim_Export");
  const [destPath, setDestPath] = useState("");
  const [resizeMode, setResizeMode] = useState<"none" | "long_edge" | "percent">("none");
  const [longEdge, setLongEdge] = useState(2048);
  const [percent, setPercent] = useState(50);
  const [stripGps, setStripGps] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const targetIds =
    selectedIds.size > 0
      ? Array.from(selectedIds)
      : focusedId != null
        ? [focusedId]
        : [];

  async function pickDestPath() {
    const sel = await openDialog({ directory: true, multiple: false });
    if (sel && typeof sel === "string") setDestPath(sel);
  }

  async function submit() {
    if (targetIds.length === 0 || submitting) return;
    setSubmitting(true);
    try {
    const destination: Destination =
      destKind === "subfolder"
        ? { kind: "subfolder", name: subfolder || "FujiSim_Export" }
        : { kind: "path", path: destPath };
    const resize: ResizeSpec | null =
      resizeMode === "long_edge"
        ? { long_edge: longEdge }
        : resizeMode === "percent"
          ? { percent }
          : null;
    const settings: ExportSettings = {
      format,
      quality,
      destination,
      resize,
      strip_gps: stripGps,
      filename_template: null,
    };

    // 根据 resize 设置计算实际导出尺寸
    function exportDims(assetW: number, assetH: number): { w: number; h: number } {
      if (!resize) return { w: assetW, h: assetH };
      if ("long_edge" in resize) {
        const s = resize.long_edge / Math.max(assetW, assetH);
        return { w: Math.round(assetW * s), h: Math.round(assetH * s) };
      }
      const s = (resize as { percent: number }).percent / 100;
      return { w: Math.round(assetW * s), h: Math.round(assetH * s) };
    }

    // 没有 EXIF 尺寸的图片用 HTMLImageElement 异步读 naturalWidth/Height 兜底
    async function resolveDims(asset: { id: number; file_path: string; width: number | null; height: number | null; is_raw?: boolean }): Promise<{ w: number; h: number } | null> {
      if (asset.width && asset.height) return { w: asset.width, h: asset.height };
      if (asset.is_raw) return null;
      try {
        const url = (await import("@tauri-apps/api/core")).convertFileSrc(asset.file_path);
        return await new Promise((resolve) => {
          const im = new Image();
          im.onload = () => resolve(im.naturalWidth && im.naturalHeight ? { w: im.naturalWidth, h: im.naturalHeight } : null);
          im.onerror = () => resolve(null);
          im.src = url;
        });
      } catch {
        return null;
      }
    }

    // 为每个 asset 按其实际显示尺寸独立渲染水印，避免不同宽高比时水印被拉伸压缩
    type WatermarkEntry = { asset_id: number; layer: { data: string; width: number; height: number; opacity: number } };
    let perAssetWatermark: WatermarkEntry[] | null = null;
    if (watermark.enabled && watermark.text.trim()) {
      perAssetWatermark = [];
      for (const id of targetIds) {
        const asset = assets.find((a) => a?.id === id);
        if (!asset) continue;
        const dims = await resolveDims(asset as any);
        if (!dims) continue;
        const aw = dims.w;
        const ah = dims.h;
        const { w: exportW } = exportDims(aw, ah);
        // 预览 canvas 基准尺寸（与 PreviewPanel 里的 MAX 保持一致）
        const PREVIEW_MAX = 1280;
        const previewS = Math.min(1, PREVIEW_MAX / Math.max(aw, ah));
        const previewCanvasW = Math.round(aw * previewS);
        const previewCanvasH = Math.round(ah * previewS);
        // 导出 scale = 导出尺寸 / 预览 canvas 尺寸，保持 fontSize 比例一致
        const wmScale = exportW / previewCanvasW;
        const layer = await renderWatermarkLayer(watermark, previewCanvasW, previewCanvasH, wmScale);
        perAssetWatermark.push({ asset_id: id, layer: { ...layer, opacity: watermark.opacity } });
      }
    }

    await api.startBatchExport({
      asset_ids: targetIds,
      filter,
      export: settings,
      per_asset_watermark: perAssetWatermark,
      watermark_settings: watermark.enabled ? watermark : null,
    });
    onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogTitle>{t("exportDialog.title", { count: targetIds.length })}</DialogTitle>
        <div className="py-4 px-0.5 overflow-hidden">
          <DialogDescription>
            {t("exportDialog.subtitle")}
          </DialogDescription>

          <div className="mt-4 space-y-4 max-h-[60vh] overflow-y-auto pr-1">
            <Row label={t("exportDialog.format")}>
              <Select value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="jpeg">JPEG</SelectItem>
                  <SelectItem value="png">PNG</SelectItem>
                  <SelectItem value="tiff">TIFF</SelectItem>
                  <SelectItem value="webp">WebP</SelectItem>
                  <SelectItem value="gif">GIF</SelectItem>
                  <SelectItem value="bmp">BMP</SelectItem>
                </SelectContent>
              </Select>
            </Row>

            {LOSSY_FORMATS.includes(format) && (
              <Row label={t("exportDialog.quality", { value: quality })}>
                <input
                  type="range"
                  min={60}
                  max={100}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                  className="w-full accent-primary"
                />
              </Row>
            )}

            <Row label={t("exportDialog.saveTo")}>
              <div className="flex gap-2">
                <Select value={destKind} onValueChange={(v) => setDestKind(v as "subfolder" | "path")}>
                  <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="subfolder">{t("exportDialog.saveToOriginalDir")}</SelectItem>
                    <SelectItem value="path">{t("exportDialog.saveToCustomDir")}</SelectItem>
                  </SelectContent>
                </Select>
                {destKind === "subfolder" ? (
                  <Input value={subfolder} onChange={(e) => setSubfolder(e.target.value)} placeholder="FujiSim_Export" />
                ) : (
                  <div className="flex flex-1 gap-1 items-center">
                    <Input value={destPath} onChange={(e) => setDestPath(e.target.value)} placeholder="/path" />
                    <Button className="flex-shrink-0" size="sm" variant="secondary" onClick={pickDestPath}>
                      {t("exportDialog.choosePath")}
                    </Button>
                  </div>
                )}
              </div>
            </Row>

            <Row label={t("exportDialog.size")}>
              <div className="flex gap-2">
                <Select value={resizeMode} onValueChange={(v) => setResizeMode(v as "none" | "long_edge" | "percent")}>
                  <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("exportDialog.sizeOriginal")}</SelectItem>
                    <SelectItem value="long_edge">{t("exportDialog.sizeLongEdge")}</SelectItem>
                    <SelectItem value="percent">{t("exportDialog.sizePercent")}</SelectItem>
                  </SelectContent>
                </Select>
                {resizeMode === "long_edge" && (
                  <Input type="number" value={longEdge} onChange={(e) => setLongEdge(Number(e.target.value))} className="w-32" />
                )}
                {resizeMode === "percent" && (
                  <Input type="number" value={percent} onChange={(e) => setPercent(Number(e.target.value))} className="w-32" />
                )}
              </div>
            </Row>

            <Row label={t("exportDialog.metadata")}>
              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={stripGps}
                  onChange={(e) => setStripGps(e.target.checked)}
                  className="accent-primary"
                />
                {t("exportDialog.removeGps")}
              </label>
            </Row>

            {watermark.enabled && (
              <Row label={t("exportDialog.watermark")}>
                <p className="text-xs text-zinc-400">
                  {watermark.text.trim()
                    ? t("exportDialog.watermarkApplied", { text: watermark.text })
                    : t("exportDialog.watermarkEmpty")}
                  {!focusedAsset?.width && watermark.text.trim() && (
                    <span className="text-amber-400 ml-1">{t("exportDialog.watermarkUnknownSize")}</span>
                  )}
                </p>
              </Row>
            )}
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submit} disabled={targetIds.length === 0 || submitting}>
              {submitting && <Loader2 size={13} className="mr-1.5 animate-spin" />}
              {t("exportDialog.startExport", { count: targetIds.length })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">{label}</p>
      {children}
    </div>
  );
}

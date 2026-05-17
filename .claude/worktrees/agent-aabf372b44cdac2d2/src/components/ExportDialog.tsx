import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (b: boolean) => void;
}

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const filter = useStore((s) => s.filter);
  const selectedIds = useStore((s) => s.selectedIds);
  const focusedId = useStore((s) => s.focusedId);
  const setProgress = useStore((s) => s.setProgress);

  const [format, setFormat] = useState<ExportFormat>("jpeg");
  const [quality, setQuality] = useState(92);
  const [destKind, setDestKind] = useState<"subfolder" | "path">("subfolder");
  const [subfolder, setSubfolder] = useState("FujiSim_Export");
  const [destPath, setDestPath] = useState("");
  const [resizeMode, setResizeMode] = useState<"none" | "long_edge" | "percent">("none");
  const [longEdge, setLongEdge] = useState(2048);
  const [percent, setPercent] = useState(50);
  const [stripGps, setStripGps] = useState(false);

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
    if (targetIds.length === 0) return;
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
    setProgress({
      task_id: -1,
      total: targetIds.length,
      completed: 0,
      failed: 0,
      done: false,
      last_asset_id: null,
      last_output: null,
      last_error: null,
    });
    await api.startBatchExport({
      asset_ids: targetIds,
      filter,
      export: settings,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogTitle>导出 {targetIds.length} 张</DialogTitle>
        <div className="py-4 px-0.5 overflow-hidden">
          <DialogDescription>
            使用当前胶片参数生成新文件，不会修改原文件。
          </DialogDescription>

          <div className="mt-4 space-y-4 max-h-[60vh] overflow-y-auto pr-1">
            <Row label="格式">
              <Select
                value={format}
                onValueChange={(v) => setFormat(v as ExportFormat)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="jpeg">JPEG</SelectItem>
                  <SelectItem value="png">PNG</SelectItem>
                  <SelectItem value="tiff">TIFF</SelectItem>
                  <SelectItem value="webp">WebP</SelectItem>
                </SelectContent>
              </Select>
            </Row>

            {format === "jpeg" && (
              <Row label={`JPEG 质量 ${quality}`}>
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

            <Row label="保存到">
              <div className="flex gap-2">
                <Select
                  value={destKind}
                  onValueChange={(v) => setDestKind(v as "subfolder" | "path")}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="subfolder">原目录子文件夹</SelectItem>
                    <SelectItem value="path">自定义目录</SelectItem>
                  </SelectContent>
                </Select>
                {destKind === "subfolder" ? (
                  <Input
                    value={subfolder}
                    onChange={(e) => setSubfolder(e.target.value)}
                    placeholder="FujiSim_Export"
                  />
                ) : (
                  <div className="flex flex-1 gap-1 items-center">
                    <Input
                      value={destPath}
                      onChange={(e) => setDestPath(e.target.value)}
                      placeholder="/path"
                    />
                    <Button
                      className="flex-shrink-0"
                      size="sm"
                      variant="secondary"
                      onClick={pickDestPath}
                    >
                      选择路径
                    </Button>
                  </div>
                )}
              </div>
            </Row>

            <Row label="尺寸">
              <div className="flex gap-2">
                <Select
                  value={resizeMode}
                  onValueChange={(v) =>
                    setResizeMode(v as "none" | "long_edge" | "percent")
                  }
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">原始尺寸</SelectItem>
                    <SelectItem value="long_edge">按长边</SelectItem>
                    <SelectItem value="percent">按百分比</SelectItem>
                  </SelectContent>
                </Select>
                {resizeMode === "long_edge" && (
                  <Input
                    type="number"
                    value={longEdge}
                    onChange={(e) => setLongEdge(Number(e.target.value))}
                    className="w-32"
                  />
                )}
                {resizeMode === "percent" && (
                  <Input
                    type="number"
                    value={percent}
                    onChange={(e) => setPercent(Number(e.target.value))}
                    className="w-32"
                  />
                )}
              </div>
            </Row>

            <Row label="元数据">
              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={stripGps}
                  onChange={(e) => setStripGps(e.target.checked)}
                  className="accent-primary"
                />
                移除 GPS（MVP 仅作开关占位，完整 Exif 写回需未来加入）
              </label>
            </Row>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button onClick={submit} disabled={targetIds.length === 0}>
              开始导出 ({targetIds.length})
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">
        {label}
      </p>
      {children}
    </div>
  );
}

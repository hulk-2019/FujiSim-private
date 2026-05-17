import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Save, Trash2, Info, FolderOpen, Files, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useStore, DEFAULT_FILTER } from "@/store";
import { api } from "@/api";
import type { FilterPreset } from "@/types";
import { PASS_THROUGH_SIM } from "@/types";
import { cn, formatBytes, shortDate } from "@/lib/utils";

const GRAIN_EFFECTS = ["None", "Weak", "Medium", "Strong"];
const GRAIN_SIZES = ["Small", "Large"];
const CHROME_EFFECTS = ["None", "Weak", "Strong"];

/** 下拉框选项的复合 value：`fuji:<name>` 或 `lut:<id>`。 */
const FUJI_PREFIX = "fuji:";
const LUT_PREFIX = "lut:";

export function FilterPanel() {
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const resetFilter = useStore((s) => s.resetFilter);
  const presets = useStore((s) => s.presets);
  const refreshPresets = useStore((s) => s.refreshPresets);
  const applyPreset = useStore((s) => s.applyPreset);
  const fujiSimulations = useStore((s) => s.fujiSimulations);
  const userLuts = useStore((s) => s.userLuts);
  const refreshUserLuts = useStore((s) => s.refreshUserLuts);
  const assets = useStore((s) => s.assets);
  const focusedId = useStore((s) => s.focusedId);
  const focused = assets.find((a) => a.id === focusedId) ?? null;

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [importingLut, setImportingLut] = useState(false);

  useEffect(() => {
    refreshPresets();
  }, [refreshPresets]);

  // 当前选中的 simulation 在下拉框中的复合 value：
  // 如果 base_simulation 是 Pass-Through 且挂了 LUT 路径，则映射回对应的 lut:<id>，
  // 否则映射成 fuji:<name>（包括老用户预设里"富士+LUT 叠加"的情形——主下拉仍显示富士）。
  const selectedValue = (() => {
    if (filter.base_simulation === PASS_THROUGH_SIM && filter.lut_file_path) {
      const matched = userLuts.find((l) => l.file_path === filter.lut_file_path);
      if (matched) return `${LUT_PREFIX}${matched.id}`;
    }
    return `${FUJI_PREFIX}${filter.base_simulation}`;
  })();

  function handleSimulationChange(value: string) {
    if (value.startsWith(FUJI_PREFIX)) {
      const name = value.slice(FUJI_PREFIX.length);
      setFilter({ base_simulation: name, lut_file_path: null });
      return;
    }
    if (value.startsWith(LUT_PREFIX)) {
      const id = Number(value.slice(LUT_PREFIX.length));
      const lut = userLuts.find((l) => l.id === id);
      if (lut) {
        setFilter({ base_simulation: PASS_THROUGH_SIM, lut_file_path: lut.file_path });
      }
    }
  }

  async function importLuts() {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "Cube LUT", extensions: ["cube", "CUBE"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    setImportingLut(true);
    try {
      await api.importLuts(paths);
      await refreshUserLuts();
    } finally {
      setImportingLut(false);
    }
  }

  async function importLutsFromDir() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") return;
    setImportingLut(true);
    try {
      await api.importLutsFromDir(selected);
      await refreshUserLuts();
    } finally {
      setImportingLut(false);
    }
  }

  async function removeUserLut(id: number) {
    const target = userLuts.find((l) => l.id === id);
    await api.deleteUserLut(id);
    // 若被删的 LUT 正在使用，回到默认富士配方
    if (target && filter.lut_file_path === target.file_path) {
      setFilter({ base_simulation: DEFAULT_FILTER.base_simulation, lut_file_path: null });
    }
    await refreshUserLuts();
  }

  async function saveAsPreset() {
    if (!saveName.trim()) return;
    await api.savePreset({
      name: saveName.trim(),
      base_simulation: filter.base_simulation,
      grain_effect: filter.grain_effect ?? null,
      grain_size: filter.grain_size ?? null,
      color_chrome_effect: filter.color_chrome_effect ?? null,
      highlight_tone: filter.highlight_tone,
      shadow_tone: filter.shadow_tone,
      color_saturation: filter.color_saturation,
      clarity: filter.clarity,
      sharpness: filter.sharpness,
      wb_shift_r: filter.wb_shift_r,
      wb_shift_b: filter.wb_shift_b,
      lut_file_path: filter.lut_file_path ?? null,
      is_builtin: false,
    });
    setSaveOpen(false);
    setSaveName("");
    await refreshPresets();
  }

  async function removePreset(p: FilterPreset) {
    if (p.is_builtin) return;
    await api.deletePreset(p.id);
    await refreshPresets();
  }

  return (
    <aside className="w-full h-full bg-transparent flex flex-col text-sm overflow-hidden">
      <Tabs defaultValue="adjust" className="flex-1 flex flex-col overflow-hidden">
        <div className="px-3 pt-3">
          <TabsList className="w-full grid grid-cols-3">
            <TabsTrigger value="adjust">调整</TabsTrigger>
            <TabsTrigger value="presets">预设</TabsTrigger>
            <TabsTrigger value="info">信息</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="adjust" className="flex-1 overflow-y-auto px-4 pb-6 mt-4 space-y-6">
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label>胶片模拟</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={importingLut}
                    className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
                  >
                    {importingLut ? "导入中…" : "导入 LUT"}
                    <ChevronDown size={10} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={importLuts}>
                    <Files size={13} />
                    选择文件（批量多选）
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={importLutsFromDir}>
                    <FolderOpen size={13} />
                    选择目录（递归扫描）
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <Select value={selectedValue} onValueChange={handleSimulationChange}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>系统预设</SelectLabel>
                  {fujiSimulations.map((s) => (
                    <SelectItem key={s} value={`${FUJI_PREFIX}${s}`}>{s}</SelectItem>
                  ))}
                </SelectGroup>
                {userLuts.length > 0 && (
                  <>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>用户自定义</SelectLabel>
                      {userLuts.map((l) => (
                        <SelectItem key={l.id} value={`${LUT_PREFIX}${l.id}`}>
                          {l.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </>
                )}
              </SelectContent>
            </Select>
            {filter.base_simulation === PASS_THROUGH_SIM && filter.lut_file_path && (
              <p className="mt-1 text-[10px] text-zinc-500">
                已应用用户 LUT，富士配方此次绕过；用户滑块仍生效。
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>颗粒强度</Label>
              <Select value={filter.grain_effect ?? "None"} onValueChange={(v) => setFilter({ grain_effect: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {GRAIN_EFFECTS.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>颗粒大小</Label>
              <Select value={filter.grain_size ?? "Small"} onValueChange={(v) => setFilter({ grain_size: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {GRAIN_SIZES.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Color Chrome</Label>
            <Select value={filter.color_chrome_effect ?? "None"} onValueChange={(v) => setFilter({ color_chrome_effect: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CHROME_EFFECTS.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <SliderRow
            label="高光" value={filter.highlight_tone} min={-1} max={1} step={0.05}
            onChange={(v) => setFilter({ highlight_tone: v })}
          />
          <SliderRow
            label="阴影" value={filter.shadow_tone} min={-1} max={1} step={0.05}
            onChange={(v) => setFilter({ shadow_tone: v })}
          />
          <SliderRow
            label="饱和度" value={filter.color_saturation} min={-1} max={1} step={0.05}
            onChange={(v) => setFilter({ color_saturation: v })}
          />
          <SliderRow
            label="清晰度" value={filter.clarity} min={-1} max={1} step={0.05}
            onChange={(v) => setFilter({ clarity: v })}
          />
          <SliderRow
            label="锐度" value={filter.sharpness} min={-1} max={1} step={0.05}
            onChange={(v) => setFilter({ sharpness: v })}
          />
          <SliderRow
            label="白平衡偏移 R" value={filter.wb_shift_r} min={-9} max={9} step={1} display={v => v.toFixed(0)}
            onChange={(v) => setFilter({ wb_shift_r: v })}
          />
          <SliderRow
            label="白平衡偏移 B" value={filter.wb_shift_b} min={-9} max={9} step={1} display={v => v.toFixed(0)}
            onChange={(v) => setFilter({ wb_shift_b: v })}
          />

          <div className="flex gap-2 pt-4 border-t border-zinc-800/60 mt-4">
            <Button size="sm" variant="outline" onClick={resetFilter} className="flex-1 border-zinc-800 hover:bg-zinc-800">重置</Button>
            <Button size="sm" variant="default" onClick={() => setSaveOpen(true)} className="flex-1">
              <Save size={12} /> 存为预设
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="presets" className="flex-1 overflow-y-auto px-3 pb-4 mt-3 space-y-3">
          <div className="space-y-1">
            <p className="px-1 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">系统预设</p>
            {presets.filter((p) => p.is_builtin).map((p) => (
              <PresetRow key={p.id} preset={p} active={filter.base_simulation === p.base_simulation} onApply={() => applyPreset(p)} />
            ))}
          </div>
          <div className="space-y-1">
            <p className="px-1 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">用户自定义</p>
            {presets.filter((p) => !p.is_builtin).length === 0 && userLuts.length === 0 && (
              <p className="px-1 text-[11px] text-zinc-600">暂无。可在“调整”面板里"存为预设"，或导入 .cube LUT。</p>
            )}
            {presets.filter((p) => !p.is_builtin).map((p) => (
              <PresetRow
                key={p.id}
                preset={p}
                active={false}
                onApply={() => applyPreset(p)}
                onDelete={() => removePreset(p)}
              />
            ))}
            {userLuts.map((l) => (
              <div
                key={`lut-${l.id}`}
                className={cn(
                  "group flex items-center gap-2 rounded-md border border-zinc-800 px-2 py-1.5 hover:border-zinc-600 cursor-pointer",
                  filter.lut_file_path === l.file_path && "border-emerald-700",
                )}
                onClick={() => handleSimulationChange(`${LUT_PREFIX}${l.id}`)}
              >
                <div className="w-3 h-3 rounded-sm bg-sky-500" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-zinc-100 truncate">{l.name}</p>
                  <p className="text-[10px] text-zinc-500 truncate">3D LUT</p>
                </div>
                <button
                  className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400"
                  onClick={(e) => { e.stopPropagation(); removeUserLut(l.id); }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="info" className="flex-1 overflow-y-auto px-4 pb-6 mt-4 space-y-4 text-xs">
          {focused ? (
            <div className="space-y-4">
              <div className="space-y-1 pb-4 border-b border-zinc-800/60">
                <p className="text-zinc-200 font-medium break-all">{focused.file_name}</p>
                <p className="text-zinc-500 break-all">{focused.file_path}</p>
              </div>

              <div className="grid grid-cols-2 gap-y-3 gap-x-2">
                <div className="space-y-1 min-w-0">
                  <span className="text-zinc-500">相机</span>
                  <p className="text-zinc-300 truncate" title={focused.camera_model ?? undefined}>{focused.camera_model ?? "—"}</p>
                </div>
                <div className="space-y-1 min-w-0">
                  <span className="text-zinc-500">镜头</span>
                  <p className="text-zinc-300 truncate" title={focused.lens_model ?? undefined}>{focused.lens_model ?? "—"}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-zinc-500">光圈</span>
                  <p className="text-zinc-300">{focused.f_number != null ? `f/${focused.f_number.toFixed(1)}` : "—"}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-zinc-500">快门速度</span>
                  <p className="text-zinc-300">{focused.shutter_speed ? `${focused.shutter_speed}s` : "—"}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-zinc-500">ISO</span>
                  <p className="text-zinc-300">{focused.iso ?? "—"}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-zinc-500">焦距</span>
                  <p className="text-zinc-300">{focused.focal_length != null ? `${focused.focal_length}mm` : "—"}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-zinc-500">拍摄时间</span>
                  <p className="text-zinc-300">{shortDate(focused.date_taken)}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-zinc-500">文件大小</span>
                  <p className="text-zinc-300">{formatBytes(focused.file_size)}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-zinc-500">星级</span>
                  <p className="text-zinc-300">{focused.star_rating} 星</p>
                </div>
                <div className="space-y-1">
                  <span className="text-zinc-500">类型</span>
                  <p className="text-zinc-300">{focused.file_type || (focused.is_raw ? "RAW" : "未知")}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center text-zinc-500 py-10 gap-2">
              <Info size={32} />
              <p>选中照片以查看元信息</p>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogTitle>保存为预设</DialogTitle>
          <DialogDescription>把当前参数组合保存到自定义预设。同名将覆盖。</DialogDescription>
          <Input
            className="mt-3"
            value={saveName}
            placeholder="例如：人像 暖调 +颗粒"
            onChange={(e) => setSaveName(e.target.value)}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>取消</Button>
            <Button onClick={saveAsPreset}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function PresetRow({
  preset,
  active,
  onApply,
  onDelete,
}: {
  preset: FilterPreset;
  active: boolean;
  onApply: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md border border-zinc-800 px-2 py-1.5 hover:border-zinc-600 cursor-pointer",
        active && preset.is_builtin && "border-emerald-700",
      )}
      onClick={onApply}
    >
      <div
        className={cn(
          "w-3 h-3 rounded-sm",
          preset.is_builtin ? "bg-emerald-500" : "bg-amber-500",
        )}
      />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-zinc-100 truncate">{preset.name}</p>
        <p className="text-[10px] text-zinc-500 truncate">
          {preset.is_builtin ? "内置" : "自定义"} · {preset.base_simulation}
        </p>
      </div>
      {onDelete && (
        <button
          className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-xs text-zinc-400 uppercase tracking-wider font-semibold mb-1 block">{children}</label>;
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  display?: (v: number) => string;
}) {
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="text-xs text-zinc-300">{label}</span>
        <span className="text-[10px] text-zinc-500 tabular-nums">
          {display ? display(value) : value.toFixed(2)}
        </span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
    </div>
  );
}

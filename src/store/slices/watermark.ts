import type { StateCreator } from "zustand";
import { api } from "../../api";
import { DEFAULT_WATERMARK } from "../../types";
import type { AppState, WatermarkSlice } from "../types";

export const createWatermarkSlice: StateCreator<AppState, [], [], WatermarkSlice> = (set, get) => ({
  watermark: { ...DEFAULT_WATERMARK },
  watermarkPresets: [],
  userWatermarkSvgs: [],
  selectedWatermarkPresetId: null,
  previewSize: null,
  previewSizeAssetId: null,

  setWatermark: (patch) => set({ watermark: { ...get().watermark, ...patch } }),
  setPreviewSize: (size, assetId) => set({ previewSize: size, previewSizeAssetId: assetId ?? null }),
  refreshWatermarkPresets: async () => {
    const presets = await api.listWatermarkPresets().catch(() => []);
    set({ watermarkPresets: presets });
  },
  refreshUserWatermarkSvgs: async () => {},
  importWatermarkSvgs: async (paths) => {
    void paths;
    return [];
  },
  removeUserWatermarkSvg: async (id) => {
    void id;
  },
  applyImportedWatermarkSvg: (svg) => {
    set({
      watermark: {
        ...get().watermark,
        enabled: true,
        kind: "svg",
        source: "imported",
        svgId: svg.id,
        svgMarkup: svg.preview_svg ?? "",
        name: svg.name,
      },
      selectedWatermarkPresetId: null,
    });
  },
  addWatermarkPreset: async (name) => {
    const { position: _pos, offsetX: _ox, offsetY: _oy, ...rest } = get().watermark;
    const settingsJson = JSON.stringify(rest);
    const preset = await api.createWatermarkPreset(name, settingsJson);
    set({
      watermarkPresets: [...get().watermarkPresets, preset],
      selectedWatermarkPresetId: preset.id,
    });
  },
  updateWatermarkPreset: async (id, name) => {
    const { position: _pos, offsetX: _ox, offsetY: _oy, ...rest } = get().watermark;
    const settingsJson = JSON.stringify(rest);
    const updated = await api.updateWatermarkPreset(id, name, settingsJson);
    set({ watermarkPresets: get().watermarkPresets.map((p) => (p.id === id ? updated : p)) });
  },
  removeWatermarkPreset: async (id) => {
    await api.deleteWatermarkPreset(id);
    const next = get().watermarkPresets.filter((p) => p.id !== id);
    set({
      watermarkPresets: next,
      selectedWatermarkPresetId:
        get().selectedWatermarkPresetId === id ? null : get().selectedWatermarkPresetId,
    });
  },
  applyWatermarkPreset: (preset) => {
    try {
      const {
        position: _pos,
        offsetX: _ox,
        offsetY: _oy,
        enabled: _en,
        ...settings
      } = JSON.parse(preset.settings_json);
      set({
        watermark: {
          ...get().watermark,
          ...settings,
          enabled: true,
          position: "bottom-center",
          offsetX: 0,
          offsetY: 0,
        },
        selectedWatermarkPresetId: preset.id,
      });
    } catch { /* ignore malformed json */ }
  },
  setSelectedWatermarkPresetId: (id) => set({ selectedWatermarkPresetId: id }),
});

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api";
import type { Asset, FilterSettings, PreviewTileRequest } from "@/types";
import { nextPreviewToken } from "./previewRequest";
import { previewResultToImage, revokePreviewImage, type PreviewImage } from "./previewImages";

const TILE_IDLE_DELAY_MS = 260;
const TILE_MAX_OUTPUT_EDGE = 2048;
const TILE_SOURCE_SIZE = 1024;
const TILE_PREFETCH_MARGIN = 1;
const TILE_CACHE_MAX_ITEMS = 96;
const TILE_PIPELINE_VERSION = 1;
const MAX_TILES_PER_PASS = 24;
const TILE_REQUEST_CONCURRENCY = 2;

export type TilePreview = PreviewImage & {
  assetId: number;
  cacheKey: string;
  tile: PreviewTileRequest;
};

type TileCacheEntry = {
  key: string;
  preview: TilePreview;
};

const tileCache = new Map<string, TileCacheEntry>();

function touchTileCache(key: string) {
  const entry = tileCache.get(key);
  if (!entry) return null;
  tileCache.delete(key);
  tileCache.set(key, entry);
  return entry.preview;
}

function putTileCache(key: string, preview: TilePreview) {
  const existing = tileCache.get(key);
  if (existing) {
    revokePreviewImage(existing.preview);
    tileCache.delete(key);
  }

  tileCache.set(key, { key, preview });
  while (tileCache.size > TILE_CACHE_MAX_ITEMS) {
    const oldest = tileCache.values().next().value as TileCacheEntry | undefined;
    if (!oldest) break;
    tileCache.delete(oldest.key);
    revokePreviewImage(oldest.preview);
  }
}

function filterKey(filter: FilterSettings) {
  return JSON.stringify(filter);
}

function zoomBucket(scale: number) {
  return Math.max(1, Math.round(scale * 100));
}

export function useTilePreview({
  focused,
  filter,
  enabled,
  scale,
  tx,
  ty,
  viewportWidth,
  viewportHeight,
  imageWidth,
  imageHeight,
  projectId,
}: {
  focused: Asset | null;
  filter: FilterSettings;
  enabled: boolean;
  scale: number;
  tx: number;
  ty: number;
  viewportWidth: number;
  viewportHeight: number;
  imageWidth: number;
  imageHeight: number;
  projectId?: number | null;
}) {
  const [previews, setPreviews] = useState<TilePreview[]>([]);
  const activeRunRef = useRef(0);

  const request = useMemo(() => {
    if (!enabled || !focused || scale <= 0 || !viewportWidth || !viewportHeight || !imageWidth || !imageHeight) {
      return null;
    }

    const visibleX0 = Math.max(0, Math.floor((0 - tx) / scale));
    const visibleY0 = Math.max(0, Math.floor((0 - ty) / scale));
    const visibleX1 = Math.min(imageWidth, Math.ceil((viewportWidth - tx) / scale));
    const visibleY1 = Math.min(imageHeight, Math.ceil((viewportHeight - ty) / scale));
    if (visibleX1 <= visibleX0 || visibleY1 <= visibleY0) return null;

    const minTileX = Math.max(0, Math.floor(visibleX0 / TILE_SOURCE_SIZE) - TILE_PREFETCH_MARGIN);
    const minTileY = Math.max(0, Math.floor(visibleY0 / TILE_SOURCE_SIZE) - TILE_PREFETCH_MARGIN);
    const maxTileX = Math.min(
      Math.ceil(imageWidth / TILE_SOURCE_SIZE) - 1,
      Math.floor((visibleX1 - 1) / TILE_SOURCE_SIZE) + TILE_PREFETCH_MARGIN,
    );
    const maxTileY = Math.min(
      Math.ceil(imageHeight / TILE_SOURCE_SIZE) - 1,
      Math.floor((visibleY1 - 1) / TILE_SOURCE_SIZE) + TILE_PREFETCH_MARGIN,
    );

    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const filterHash = filterKey(filter);
    const zBucket = zoomBucket(scale);
    const tiles: { key: string; tile: PreviewTileRequest; distance: number }[] = [];
    const centerX = (visibleX0 + visibleX1) / 2;
    const centerY = (visibleY0 + visibleY1) / 2;

    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
        const x = tileX * TILE_SOURCE_SIZE;
        const y = tileY * TILE_SOURCE_SIZE;
        const width = Math.min(TILE_SOURCE_SIZE, imageWidth - x);
        const height = Math.min(TILE_SOURCE_SIZE, imageHeight - y);
        if (width <= 0 || height <= 0) continue;

        const desiredW = Math.max(1, Math.round(width * scale * dpr));
        const desiredH = Math.max(1, Math.round(height * scale * dpr));
        const outputScale = Math.min(1, TILE_MAX_OUTPUT_EDGE / Math.max(desiredW, desiredH));
        const key = [
          focused.id,
          TILE_PIPELINE_VERSION,
          filterHash,
          zBucket,
          tileX,
          tileY,
          width,
          height,
        ].join(":");
        const tileCenterX = x + width / 2;
        const tileCenterY = y + height / 2;
        tiles.push({
          key,
          tile: {
            x,
            y,
            width,
            height,
            outputWidth: Math.max(1, Math.round(desiredW * outputScale)),
            outputHeight: Math.max(1, Math.round(desiredH * outputScale)),
          },
          distance: Math.hypot(tileCenterX - centerX, tileCenterY - centerY),
        });
      }
    }

    tiles.sort((a, b) => a.distance - b.distance);
    return { assetId: focused.id, tiles: tiles.slice(0, MAX_TILES_PER_PASS) };
  }, [enabled, filter, focused, imageHeight, imageWidth, scale, tx, ty, viewportHeight, viewportWidth]);

  useEffect(() => {
    if (!enabled || !focused || !request) {
      activeRunRef.current += 1;
      setPreviews([]);
      return;
    }

    const cached = request.tiles
      .map(({ key }) => touchTileCache(key))
      .filter((preview): preview is TilePreview => !!preview);
    setPreviews(cached);

    const missing = request.tiles.filter(({ key }) => !tileCache.has(key));
    if (missing.length === 0) return;

    const runId = activeRunRef.current + 1;
    activeRunRef.current = runId;
    const controller = new AbortController();

    const handle = setTimeout(async () => {
      let cursor = 0;

      const loadNext = async (): Promise<void> => {
        if (controller.signal.aborted || activeRunRef.current !== runId) return;
        const item = missing[cursor];
        cursor += 1;
        if (!item) return;

        const existing = touchTileCache(item.key);
        if (existing) {
          setPreviews((prev) => mergeTilePreviews(prev, [existing], request.tiles.map((t) => t.key)));
          await loadNext();
          return;
        }

        const token = nextPreviewToken();
        try {
          const result = await api.getPreview(focused.id, filter, "tile", undefined, token, item.tile, projectId);
          if (controller.signal.aborted || activeRunRef.current !== runId) return;
          const next = {
            assetId: focused.id,
            cacheKey: item.key,
            tile: item.tile,
            ...previewResultToImage(result),
          };
          putTileCache(item.key, next);
          setPreviews((prev) => mergeTilePreviews(prev, [next], request.tiles.map((t) => t.key)));
        } catch (e) {
          const message = String(e);
          if (!message.includes("preview_cancelled") && !message.includes("preview_busy")) {
            console.warn("[useTilePreview] failed:", message);
          }
          if (message.includes("preview_busy")) return;
        }
        if (!controller.signal.aborted) {
          await loadNext();
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(TILE_REQUEST_CONCURRENCY, missing.length) }, () => loadNext()),
      );
    }, TILE_IDLE_DELAY_MS);

    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [enabled, filter, focused, projectId, request]);

  return previews;
}

function mergeTilePreviews(
  current: TilePreview[],
  incoming: TilePreview[],
  orderedKeys: string[],
) {
  const byKey = new Map(current.map((preview) => [preview.cacheKey, preview]));
  for (const preview of incoming) {
    byKey.set(preview.cacheKey, preview);
  }
  return orderedKeys
    .map((key) => byKey.get(key))
    .filter((preview): preview is TilePreview => !!preview);
}

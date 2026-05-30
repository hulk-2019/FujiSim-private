import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/api";
import type { Asset } from "@/types";

export type AssetThumbnailImage = {
  orientation?: number | null;
  src: string;
};

const thumbnailCache = new Map<number, AssetThumbnailImage>();

export function initialAssetThumbnail(asset: Asset | null): AssetThumbnailImage | null {
  if (!asset) return null;
  if (asset.is_raw) return thumbnailCache.get(asset.id) ?? null;
  try {
    return { src: convertFileSrc(asset.cover_path ?? asset.file_path) };
  } catch {
    return null;
  }
}

export function useAssetThumbnail(asset: Asset | null) {
  const [image, setImage] = useState<AssetThumbnailImage | null>(() => initialAssetThumbnail(asset));

  useEffect(() => {
    let cancelled = false;

    if (!asset) {
      setImage(null);
      return;
    }

    const cached = thumbnailCache.get(asset.id);
    if (cached) {
      setImage(cached);
      return;
    }

    if (!asset.is_raw && asset.cover_path) {
      try {
        const next = { src: convertFileSrc(asset.cover_path) };
        thumbnailCache.set(asset.id, next);
        setImage(next);
      } catch {
        setImage(null);
      }
      return;
    }

    if (!asset.is_raw) {
      try {
        const next = { src: convertFileSrc(asset.file_path) };
        setImage(next);
      } catch {
        setImage(null);
      }
      return;
    }

    setImage(null);
    api.getAssetThumbnail(asset.id)
      .then((result) => {
        if (cancelled) return;
        if (result.data?.length) {
          const blob = new Blob([new Uint8Array(result.data)], {
            type: result.mimeType ?? "image/jpeg",
          });
          const url = URL.createObjectURL(blob);
          const next = { src: url, orientation: result.orientation ?? null };
          thumbnailCache.set(asset.id, next);
          setImage(next);
          return;
        }
        if (result.path) {
          const url = convertFileSrc(result.path);
          const next = { src: url, orientation: result.orientation ?? null };
          thumbnailCache.set(asset.id, next);
          setImage(next);
        }
      })
      .catch(() => {
        if (!cancelled) setImage(null);
      });

    return () => {
      cancelled = true;
    };
  }, [asset?.cover_path, asset?.file_path, asset?.id, asset?.is_raw]);

  return image;
}

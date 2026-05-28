import { convertFileSrc } from "@tauri-apps/api/core";
import type { PreviewResult } from "@/types";

export type PreviewImage = {
  blobUrl: string;
  width: number;
  height: number;
  revoke?: boolean;
};

export type AssetPreviewImage = PreviewImage & {
  assetId: number;
};

export function revokePreviewImage(img: PreviewImage | null | undefined) {
  if (img?.revoke) {
    setTimeout(() => URL.revokeObjectURL(img.blobUrl), 0);
  }
}

export function previewResultToImage(result: PreviewResult): PreviewImage {
  if (result.data?.length) {
    const bytes = new Uint8Array(result.data);
    const blob = new Blob([bytes], { type: result.mimeType ?? "image/jpeg" });
    return {
      blobUrl: URL.createObjectURL(blob),
      width: result.width,
      height: result.height,
      revoke: true,
    };
  }

  if (!result.path) {
    throw new Error("preview result missing path or data");
  }

  return {
    blobUrl: convertFileSrc(result.path),
    width: result.width,
    height: result.height,
  };
}

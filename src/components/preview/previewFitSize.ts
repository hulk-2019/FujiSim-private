import type { Asset } from "@/types";

export type PreviewFitSize = {
  width?: number | null;
  height?: number | null;
} | null | undefined;

function completeSize(size: PreviewFitSize): size is { width: number; height: number } {
  return !!size?.width && !!size.height;
}

export function previewFitSize({
  fallbackSize,
  focused,
}: {
  fallbackSize?: PreviewFitSize;
  focused: Asset | null;
}) {
  if (!focused) return { width: 0, height: 0 };

  if (focused.is_raw && completeSize(fallbackSize)) {
    return { width: fallbackSize.width, height: fallbackSize.height };
  }

  return {
    width: focused.width || fallbackSize?.width || 0,
    height: focused.height || fallbackSize?.height || 0,
  };
}

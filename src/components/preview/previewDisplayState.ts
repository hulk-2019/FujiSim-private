import { convertFileSrc } from "@tauri-apps/api/core";
import type { Asset } from "@/types";
import type { AssetPreviewImage, PreviewImage } from "./previewImages";

/**
 * 判断当前后端预览图是否应该显示。
 *
 * identity 状态下优先显示 baseline；只有非 identity 或全分辨率模式下，
 * 后端 preview 才代表用户当前需要看的结果。
 */
export function focusedPreviewImage({
  focused,
  preview,
  filterIsIdentity,
  useFullResolutionPreview,
  useTileDetailPreview,
}: {
  focused: Asset | null;
  preview: AssetPreviewImage | null;
  filterIsIdentity: boolean;
  useFullResolutionPreview: boolean;
  useTileDetailPreview: boolean;
}) {
  if (!focused || preview?.assetId !== focused.id) return null;
  if (!filterIsIdentity || (useFullResolutionPreview && !useTileDetailPreview)) {
    return preview;
  }
  return null;
}

/**
 * 计算 PreviewPanel 的显示源和图层开关。
 *
 * 这个函数只做派生判断，不触发副作用。把这些条件集中起来，
 * 可以避免 PreviewPanel 内部散落 preview/base/original/GPU/skeleton 的组合判断。
 */
export function previewDisplayState({
  focused,
  currentPreview,
  currentBaselinePreview,
  containerW,
  containerH,
  gpuHandoffActive,
  gpuInteractiveReady,
  gpuInteractiveSrc,
  imgVisible,
  initializingBase,
  canUseGpuInteractivePreview,
  shouldApproximateWithGpu,
  showOriginal,
}: {
  focused: Asset;
  currentPreview: AssetPreviewImage | null;
  currentBaselinePreview: PreviewImage | null;
  containerW: number;
  containerH: number;
  gpuHandoffActive: boolean;
  gpuInteractiveReady: boolean;
  gpuInteractiveSrc: string | null;
  imgVisible: boolean;
  initializingBase: boolean;
  canUseGpuInteractivePreview: boolean;
  shouldApproximateWithGpu: boolean;
  showOriginal: boolean;
}) {
  const previewSrc = currentPreview?.blobUrl ?? null;
  const baselineSrc = currentBaselinePreview?.blobUrl ?? null;
  // RAW 的“原图/占位”使用 baseline TIFF；普通图片直接使用原文件。
  const fileSrc = focused.is_raw ? null : safeConvertFileSrc(focused.file_path);
  const originalSrc = focused.is_raw ? baselineSrc : fileSrc;
  const showingOriginal = showOriginal && !!originalSrc;
  const placeholderSrc = focused.is_raw ? null : fileSrc;
  const displaySrc = previewSrc ?? baselineSrc ?? placeholderSrc;
  const hasImageSource = !!displaySrc || !!originalSrc;
  const showSkeleton =
    !!focused.width &&
    !!focused.height &&
    !!containerW &&
    !!containerH &&
    initializingBase &&
    !hasImageSource;
  const showGpuInteractiveLayer =
    imgVisible &&
    !showOriginal &&
    !!gpuInteractiveSrc &&
    gpuInteractiveReady &&
    canUseGpuInteractivePreview &&
    (shouldApproximateWithGpu || gpuHandoffActive);

  return {
    baselineSrc,
    displaySrc,
    originalSrc,
    previewSrc,
    showingOriginal,
    showGpuInteractiveLayer,
    showSkeleton,
  };
}

/**
 * 水印需要基于原始图像坐标定位。
 *
 * 优先使用数据库中的原图尺寸；缺失时再依次回退到当前 preview、
 * baseline 或浏览器已加载图片的 natural 尺寸。
 */
export function watermarkDimensions({
  baselinePreview,
  focused,
  imageNaturalHeight,
  imageNaturalWidth,
  preview,
}: {
  baselinePreview: PreviewImage | null;
  focused: Asset;
  imageNaturalHeight?: number;
  imageNaturalWidth?: number;
  preview: AssetPreviewImage | null;
}) {
  if (focused.width && focused.height) {
    return { width: focused.width, height: focused.height };
  }
  if (preview?.width && preview.height) {
    return { width: preview.width, height: preview.height };
  }
  if (baselinePreview?.width && baselinePreview.height) {
    return { width: baselinePreview.width, height: baselinePreview.height };
  }
  if (imageNaturalWidth && imageNaturalHeight) {
    return { width: imageNaturalWidth, height: imageNaturalHeight };
  }
  return null;
}

function safeConvertFileSrc(path: string) {
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

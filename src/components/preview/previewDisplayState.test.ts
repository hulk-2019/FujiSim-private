import { describe, expect, it } from "vitest";
import { shouldShowTransitionFrame, previewDisplayState } from "@/components/preview/previewDisplayState";
import type { Asset } from "@/types";

const imageAsset: Asset = {
  id: 1,
  file_path: "/tmp/fujisim-test.jpg",
  file_name: "fujisim-test.jpg",
  file_size: 100,
  star_rating: 0,
  width: 1000,
  height: 700,
  is_raw: 0,
  cover_path: null,
  created_at: "2026-05-30",
};

describe("previewDisplayState", () => {
  it("uses the backend baseline as the display source for non-raw identity previews", () => {
    const state = previewDisplayState({
      focused: imageAsset,
      currentPreview: null,
      currentBaselinePreview: {
        blobUrl: "blob:baseline",
        width: 800,
        height: 560,
      },
      containerW: 800,
      containerH: 560,
      gpuHandoffActive: false,
      gpuInteractiveReady: false,
      gpuInteractiveSrc: null,
      imgVisible: true,
      initializingBase: false,
      canUseGpuInteractivePreview: false,
      shouldApproximateWithGpu: false,
      showOriginal: false,
    });

    expect(state.displaySrc).toBe("blob:baseline");
  });

  it("keeps non-raw images on the backend preview when a preview is available", () => {
    const state = previewDisplayState({
      focused: imageAsset,
      currentPreview: {
        assetId: imageAsset.id,
        blobUrl: "blob:preview",
        width: 800,
        height: 560,
      },
      currentBaselinePreview: {
        blobUrl: "blob:baseline",
        width: 800,
        height: 560,
      },
      containerW: 800,
      containerH: 560,
      gpuHandoffActive: false,
      gpuInteractiveReady: false,
      gpuInteractiveSrc: null,
      imgVisible: true,
      initializingBase: false,
      canUseGpuInteractivePreview: false,
      shouldApproximateWithGpu: false,
      showOriginal: false,
    });

    expect(state.displaySrc).toBe("blob:preview");
    expect(state.originalSrc).toBe("blob:baseline");
  });
});

describe("shouldShowTransitionFrame", () => {
  it("does not show the previous frame after switching to another asset", () => {
    expect(
      shouldShowTransitionFrame({
        currentFocusedId: 2,
        lastFrameAssetId: 1,
        waitingForCurrentImage: true,
        hasDisplaySrc: true,
        hasOriginalSrc: false,
        hasPlaceholder: false,
        showingOriginal: false,
      }),
    ).toBe(false);
  });

  it("keeps the previous frame while the same asset is waiting for a refreshed preview", () => {
    expect(
      shouldShowTransitionFrame({
        currentFocusedId: 1,
        lastFrameAssetId: 1,
        waitingForCurrentImage: true,
        hasDisplaySrc: true,
        hasOriginalSrc: false,
        hasPlaceholder: false,
        showingOriginal: false,
      }),
    ).toBe(true);
  });
});

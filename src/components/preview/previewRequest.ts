export const INTERACTIVE_PREVIEW_MAX_EDGE = 960;
export const SETTLED_PREVIEW_MAX_EDGE = 1920;
export const INTERACTIVE_PREVIEW_DELAY_MS = 160;
export const SETTLED_PREVIEW_DELAY_MS = 250;
export const FULL_RESOLUTION_PREVIEW_OVERSAMPLE = 1.15;

let previewTokenCounter = 0;

export function nextPreviewToken() {
  previewTokenCounter += 1;
  return previewTokenCounter;
}

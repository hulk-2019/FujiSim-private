import { describe, expect, it } from "vitest";
import { containedImageRect, getWatermarkOverlayStyle } from "@/components/preview/WatermarkOverlay";

describe("getWatermarkOverlayStyle", () => {
  it("renders the watermark svg directly in the displayed image box", () => {
    const style = getWatermarkOverlayStyle({
      displayH: 300,
      displayW: 400,
    });

    expect(style.width).toBe(400);
    expect(style.height).toBe(300);
    expect(style.transform).toBeUndefined();
  });

  it("uses the contained image rect when source dimensions are available", () => {
    const style = getWatermarkOverlayStyle({
      displayH: 400,
      displayW: 600,
      imgH: 3000,
      imgW: 6000,
    });

    expect(style.width).toBe(600);
    expect(style.height).toBe(300);
    expect(style.left).toBe(0);
    expect(style.top).toBe(50);
  });

  it("exports the contained image rect for preview-size bookkeeping", () => {
    expect(containedImageRect({
      displayH: 400,
      displayW: 600,
      imgH: 3000,
      imgW: 6000,
    })).toEqual({
      left: 0,
      top: 50,
      width: 600,
      height: 300,
    });
  });
});

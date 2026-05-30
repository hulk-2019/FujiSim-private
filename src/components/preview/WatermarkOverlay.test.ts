import { describe, expect, it } from "vitest";
import {
  containedImageRect,
  getPreviewScaledWatermark,
  getWatermarkOverlayImageSize,
  getWatermarkOverlayStyle,
} from "@/components/preview/WatermarkOverlay";
import { DEFAULT_WATERMARK } from "@/types";

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

  it("builds the watermark image in stable source coordinates when source dimensions exist", () => {
    expect(
      getWatermarkOverlayImageSize({
        displayH: 300,
        displayW: 600,
        imgH: 3000,
        imgW: 6000,
      }),
    ).toEqual({ width: 6000, height: 3000 });
  });

  it("falls back to display coordinates when source dimensions are missing", () => {
    expect(
      getWatermarkOverlayImageSize({
        displayH: 300,
        displayW: 600,
      }),
    ).toEqual({ width: 600, height: 300 });
  });

  it("scales preview-sized watermark settings into stable source coordinates", () => {
    const wm = getPreviewScaledWatermark({
      wm: {
        ...DEFAULT_WATERMARK,
        fontSize: 32,
        offsetX: 4,
        offsetY: -6,
        shadowBlur: 2,
        shadowOffsetX: 1,
        shadowOffsetY: -1,
        strokeWidth: 1.5,
        padding: 16,
        scale: 1.2,
      },
      displayH: 300,
      displayW: 600,
      imgH: 3000,
      imgW: 6000,
    });

    expect(wm.fontSize).toBe(320);
    expect(wm.offsetX).toBe(40);
    expect(wm.offsetY).toBe(-60);
    expect(wm.shadowBlur).toBe(20);
    expect(wm.shadowOffsetX).toBe(10);
    expect(wm.shadowOffsetY).toBe(-10);
    expect(wm.strokeWidth).toBe(15);
    expect(wm.padding).toBe(160);
    expect(wm.scale).toBe(12);
  });
});

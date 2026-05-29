import { describe, expect, it } from "vitest";
import { getWatermarkOverlayStyle } from "@/components/preview/WatermarkOverlay";

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
});

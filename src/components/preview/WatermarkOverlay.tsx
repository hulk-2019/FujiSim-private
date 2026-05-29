import { useMemo } from "react";
import type { CSSProperties } from "react";
import type { WatermarkSettings } from "@/types";
import { buildWatermarkSvg, svgToDataUrl } from "@/lib/watermarkSvg";

export function containedImageRect({
  displayH,
  displayW,
  imgH,
  imgW,
}: {
  displayH: number;
  displayW: number;
  imgH?: number;
  imgW?: number;
}) {
  if (!imgW || !imgH || displayW <= 0 || displayH <= 0) {
    return { left: 0, top: 0, width: displayW, height: displayH };
  }
  const scale = Math.min(displayW / imgW, displayH / imgH);
  const width = imgW * scale;
  const height = imgH * scale;
  return {
    left: (displayW - width) / 2,
    top: (displayH - height) / 2,
    width,
    height,
  };
}

export function getWatermarkOverlayStyle({
  displayH,
  displayW,
  imgH,
  imgW,
}: {
  displayH: number;
  displayW: number;
  imgH?: number;
  imgW?: number;
}): CSSProperties {
  if (imgW && imgH && displayW > 0 && displayH > 0) {
    const rect = containedImageRect({ displayH, displayW, imgH, imgW });
    return {
      position: "absolute",
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      pointerEvents: "none",
    };
  }

  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: displayW,
    height: displayH,
    pointerEvents: "none",
  };
}

export function WatermarkOverlay({
  displayH,
  displayW,
  wm,
  imgW,
  imgH,
}: {
  displayH: number;
  displayW: number;
  wm: WatermarkSettings;
  imgW?: number;
  imgH?: number;
}) {
  const dataUrl = useMemo(
    () => {
      const rect = containedImageRect({ displayH, displayW, imgH, imgW });
      return svgToDataUrl(buildWatermarkSvg(wm, rect.width, rect.height));
    },
    [wm, displayW, displayH, imgW, imgH],
  );

  return (
    <img
      src={dataUrl}
      alt=""
      style={getWatermarkOverlayStyle({
        displayH,
        displayW,
        imgH,
        imgW,
      })}
      draggable={false}
    />
  );
}

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

export function getWatermarkOverlayImageSize({
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
  if (imgW && imgH && imgW > 0 && imgH > 0) {
    return { width: imgW, height: imgH };
  }
  return { width: displayW, height: displayH };
}

export function getPreviewScaledWatermark({
  displayH,
  displayW,
  imgH,
  imgW,
  wm,
}: {
  displayH: number;
  displayW: number;
  imgH?: number;
  imgW?: number;
  wm: WatermarkSettings;
}): WatermarkSettings {
  if (!imgW || !imgH || imgW <= 0 || imgH <= 0 || displayW <= 0 || displayH <= 0) {
    return wm;
  }
  const rect = containedImageRect({ displayH, displayW, imgH, imgW });
  if (rect.width <= 0 || rect.height <= 0) return wm;
  const scale = (imgW / rect.width + imgH / rect.height) / 2;
  return {
    ...wm,
    fontSize: wm.fontSize * scale,
    offsetX: wm.offsetX * scale,
    offsetY: wm.offsetY * scale,
    shadowBlur: wm.shadowBlur * scale,
    shadowOffsetX: wm.shadowOffsetX * scale,
    shadowOffsetY: wm.shadowOffsetY * scale,
    strokeWidth: wm.strokeWidth * scale,
    padding: (wm.padding ?? 16) * scale,
    scale: wm.scale * scale,
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
      const size = getWatermarkOverlayImageSize({ displayH, displayW, imgH, imgW });
      const scaled = getPreviewScaledWatermark({ displayH, displayW, imgH, imgW, wm });
      return svgToDataUrl(buildWatermarkSvg(scaled, size.width, size.height));
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
      className="block h-full w-full"
      draggable={false}
    />
  );
}

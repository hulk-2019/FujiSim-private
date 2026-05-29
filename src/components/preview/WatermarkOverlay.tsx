import { useMemo } from "react";
import type { CSSProperties } from "react";
import type { WatermarkSettings } from "@/types";
import { buildWatermarkSvg, svgToDataUrl } from "@/lib/watermarkSvg";

export function getWatermarkOverlayStyle({
  displayH,
  displayW,
}: {
  displayH: number;
  displayW: number;
}): CSSProperties {
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
    () => svgToDataUrl(buildWatermarkSvg(wm, displayW, displayH)),
    [wm, displayW, displayH],
  );

  return (
    <img
      src={dataUrl}
      alt=""
      style={getWatermarkOverlayStyle({
        displayH,
        displayW,
      })}
    />
  );
}

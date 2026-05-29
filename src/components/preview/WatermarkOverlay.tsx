import { useMemo } from "react";
import type { WatermarkSettings } from "@/types";
import { buildWatermarkSvg, svgToDataUrl } from "@/lib/watermarkSvg";

export function WatermarkOverlay({
  wm,
  imgW,
  imgH,
}: {
  wm: WatermarkSettings;
  imgW: number;
  imgH: number;
}) {
  const dataUrl = useMemo(
    () => svgToDataUrl(buildWatermarkSvg(wm, imgW, imgH)),
    [wm, imgW, imgH],
  );

  return (
    <img
      src={dataUrl}
      alt=""
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: imgW,
        height: imgH,
        pointerEvents: "none",
      }}
    />
  );
}

import { useEffect, useState } from "react";
import type { WatermarkSettings } from "@/types";
import { renderWatermarkLayer } from "@/lib/watermarkCanvas";

export function WatermarkOverlay({
  wm,
  imgW,
  imgH,
}: {
  wm: WatermarkSettings;
  imgW: number;
  imgH: number;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const max = 1280;
    const s = Math.min(1, max / Math.max(imgW, imgH));
    const canvasW = Math.round(imgW * s);
    const canvasH = Math.round(imgH * s);
    renderWatermarkLayer(wm, canvasW, canvasH, 1).then((result) => {
      if (!cancelled) setDataUrl(`data:image/png;base64,${result.data}`);
    });
    return () => {
      cancelled = true;
    };
  }, [wm, imgW, imgH]);

  if (!dataUrl) return null;
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

import type { TilePreview } from "./useTilePreview";

export function TilePreviewOverlay({
  displayHeight,
  displayWidth,
  sourceHeight,
  sourceWidth,
  tilePreviews,
  assetId,
}: {
  displayHeight?: number;
  displayWidth?: number;
  sourceHeight?: number;
  sourceWidth?: number;
  tilePreviews: TilePreview[];
  assetId: number;
}) {
  const previews = tilePreviews.filter((preview) => preview.assetId === assetId);
  if (previews.length === 0) return null;

  return (
    <>
      {previews.map((preview) => {
        const frameScaleX = displayWidth && sourceWidth ? displayWidth / sourceWidth : 1;
        const frameScaleY = displayHeight && sourceHeight ? displayHeight / sourceHeight : 1;
        return (
          <img
            key={preview.cacheKey}
            src={preview.blobUrl}
            alt=""
            aria-hidden="true"
            style={{
              position: "absolute",
              left: preview.tile.x * frameScaleX,
              top: preview.tile.y * frameScaleY,
              width: preview.tile.width * frameScaleX,
              height: preview.tile.height * frameScaleY,
              pointerEvents: "none",
            }}
            draggable={false}
          />
        );
      })}
    </>
  );
}

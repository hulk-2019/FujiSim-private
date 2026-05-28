import type { TilePreview } from "./useTilePreview";

export function TilePreviewOverlay({
  tilePreviews,
  assetId,
}: {
  tilePreviews: TilePreview[];
  assetId: number;
}) {
  const previews = tilePreviews.filter((preview) => preview.assetId === assetId);
  if (previews.length === 0) return null;

  return (
    <>
      {previews.map((preview) => (
        <img
          key={preview.cacheKey}
          src={preview.blobUrl}
          alt=""
          aria-hidden="true"
          style={{
            position: "absolute",
            left: preview.tile.x,
            top: preview.tile.y,
            width: preview.tile.width,
            height: preview.tile.height,
            pointerEvents: "none",
          }}
          draggable={false}
        />
      ))}
    </>
  );
}

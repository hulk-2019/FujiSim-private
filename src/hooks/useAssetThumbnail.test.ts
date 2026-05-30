import { describe, expect, it, vi } from "vitest";
import type { Asset } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock("@/api", () => ({
  api: {
    getAssetThumbnail: vi.fn(),
  },
}));

describe("initialAssetThumbnail", () => {
  it("returns null when no asset is focused", async () => {
    const { initialAssetThumbnail } = await import("./useAssetThumbnail");

    expect(initialAssetThumbnail(null)).toBeNull();
  });

  it("does not fall back to the RAW file path when no cached thumbnail exists", async () => {
    const { initialAssetThumbnail } = await import("./useAssetThumbnail");
    const asset: Asset = {
      id: 42,
      file_path: "/photos/raw.raf",
      file_name: "raw.raf",
      file_size: 100,
      star_rating: 0,
      width: 100,
      height: 80,
      is_raw: 1,
      cover_path: null,
      created_at: "2026-05-30",
    };

    expect(initialAssetThumbnail(asset)).toBeNull();
  });

  it("uses the cover path before the source path for regular images", async () => {
    const { initialAssetThumbnail } = await import("./useAssetThumbnail");
    const asset: Asset = {
      id: 43,
      file_path: "/photos/image.jpg",
      file_name: "image.jpg",
      file_size: 100,
      star_rating: 0,
      width: 100,
      height: 80,
      is_raw: 0,
      cover_path: "/cache/image-cover.jpg",
      created_at: "2026-05-30",
    };

    expect(initialAssetThumbnail(asset)?.src).toBe("asset:///cache/image-cover.jpg");
  });
});

describe("default asset query", () => {
  it("sorts thumbnails by date taken ascending", async () => {
    const { DEFAULT_ASSET_QUERY } = await import("@/store/defaults");

    expect(DEFAULT_ASSET_QUERY).toEqual({ sort_by: "date_taken", sort_dir: "asc" });
  });
});

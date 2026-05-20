import { useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Asset } from "@/types";
import Thumb from "./Thumb";

const PAGE_SIZE = 60;
const COLS = 2;
const ROW_HEIGHT = 220;

export default function Grid({
  assets,
  totalCount,
  loadPage,
  selectedIds,
  focusedId,
  onSelect,
  onFocus,
  onToggleCheckbox,
  onRatingChange,
  onRenamed,
}: {
  assets: (Asset | undefined)[];
  totalCount: number;
  loadPage: (offset: number) => void;
  selectedIds: Set<number>;
  focusedId: number | null;
  onSelect: (a: Asset, e: React.MouseEvent) => void;
  onFocus: (a: Asset) => void;
  onToggleCheckbox: (a: Asset) => void;
  onRatingChange: (a: Asset, v: number) => void;
  onRenamed: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowCount = Math.ceil(totalCount / COLS);

  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const loadPageRef = useRef(loadPage);
  loadPageRef.current = loadPage;
  const totalCountRef = useRef(totalCount);
  totalCountRef.current = totalCount;

  const checkAndLoad = useRef(() => {
    const vItems = virtualizerRef.current?.getVirtualItems() ?? [];
    const needed = new Set<number>();
    for (const vRow of vItems) {
      for (let col = 0; col < COLS; col++) {
        const idx = vRow.index * COLS + col;
        if (
          idx < totalCountRef.current &&
          assetsRef.current[idx] === undefined
        ) {
          needed.add(Math.floor(idx / PAGE_SIZE) * PAGE_SIZE);
        }
      }
    }
    needed.forEach((offset) => loadPageRef.current(offset));
  });

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 3,
    onChange: () => queueMicrotask(() => checkAndLoad.current()),
  });

  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  useEffect(() => {
    checkAndLoad.current();
  }, [totalCount, rowCount]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => checkAndLoad.current();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto min-h-0">
      <div
        style={{
          height: virtualizer.getTotalSize() + 32,
          position: "relative",
        }}
        className="px-4"
      >
        {virtualItems.map((vRow) => (
          <div
            key={vRow.key}
            style={{
              position: "absolute",
              top: vRow.start + 16,
              left: 16,
              right: 16,
              height: vRow.size - 12,
            }}
            className="flex gap-3"
          >
            {Array.from({ length: COLS }).map((_, col) => {
              const idx = vRow.index * COLS + col;
              if (idx >= totalCount)
                return <div key={col} className="flex-1" />;
              const asset = assets[idx];
              if (!asset) {
                return (
                  <div
                    key={col}
                    style={{ height: ROW_HEIGHT - 12 }}
                    className="flex-1 rounded-md bg-zinc-900/50 border border-zinc-800/80 animate-pulse"
                  />
                );
              }
              return (
                <div key={asset.id} className="flex-1 min-w-0">
                  <Thumb
                    asset={asset}
                    selected={selectedIds.has(asset.id)}
                    focused={focusedId === asset.id}
                    onClick={(e) => {
                      onSelect(asset, e);
                      onFocus(asset);
                    }}
                    onToggleCheckbox={() => onToggleCheckbox(asset)}
                    onRatingChange={(v) => onRatingChange(asset, v)}
                    onRenamed={onRenamed}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

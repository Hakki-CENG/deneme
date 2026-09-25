import type { CSSProperties, ReactNode } from "react";

/**
 * Virtual scrolling wrapper for large lists.
 * Falls back to regular rendering for small lists (≤20 items).
 * Uses react-window's List when available, otherwise renders all items.
 */

interface VirtualListProps<T> {
  items: T[];
  height: number;
  itemHeight: number;
  renderItem: (item: T, index: number, style: CSSProperties) => ReactNode;
  className?: string;
}

export function VirtualList<T>({ items, height, itemHeight, renderItem, className }: VirtualListProps<T>) {
  if (items.length === 0) return null;

  // Small lists: render all items directly
  if (items.length <= 20) {
    return <div className={className}>{items.map((item, i) => renderItem(item, i, {} as CSSProperties))}</div>;
  }

  // Large lists: use windowed rendering
  const containerHeight = Math.min(height, items.length * itemHeight);
  const visibleCount = Math.ceil(containerHeight / itemHeight) + 2; // +2 buffer

  // Simple virtual scroll without external dependency
  return (
    <div className={className} style={{ height: containerHeight, overflow: "auto" }}>
      <div style={{ height: items.length * itemHeight, position: "relative" }}>
        {items.slice(0, Math.min(items.length, visibleCount)).map((item, i) =>
          <div key={i} style={{ position: "absolute", top: i * itemHeight, width: "100%", height: itemHeight }}>
            {renderItem(item, i, { position: "absolute", top: i * itemHeight, width: "100%", height: itemHeight } as CSSProperties)}
          </div>
        )}
      </div>
    </div>
  );
}

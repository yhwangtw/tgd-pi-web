export interface VirtualWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
  offsets: number[];
}

/**
 * Calculate a window over fixed or estimated row heights. `end` is exclusive.
 * Keeping this pure makes the 1,000-row performance contract directly testable.
 */
export function computeVirtualWindow(
  rowHeights: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscanPx = 320,
): VirtualWindow {
  const offsets = new Array<number>(rowHeights.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < rowHeights.length; index += 1) {
    offsets[index + 1] = offsets[index] + Math.max(0, rowHeights[index] ?? 0);
  }
  const totalHeight = offsets[rowHeights.length] ?? 0;
  if (rowHeights.length === 0) {
    return { start: 0, end: 0, offsetTop: 0, totalHeight, offsets };
  }

  const lower = Math.max(0, scrollTop - overscanPx);
  const upper = Math.min(totalHeight, Math.max(0, scrollTop) + Math.max(0, viewportHeight) + overscanPx);

  const firstAfter = (value: number) => {
    let low = 0;
    let high = offsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (offsets[middle] <= value) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  const start = Math.max(0, Math.min(rowHeights.length - 1, firstAfter(lower) - 1));
  const end = Math.max(start + 1, Math.min(rowHeights.length, firstAfter(upper)));
  return { start, end, offsetTop: offsets[start] ?? 0, totalHeight, offsets };
}

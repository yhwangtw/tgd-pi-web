import { describe, expect, it } from "vitest";
import { computeVirtualWindow } from "../virtual-list";

describe("computeVirtualWindow", () => {
  it("renders only the viewport plus overscan for a thousand rows", () => {
    const result = computeVirtualWindow(Array.from({ length: 1_000 }, () => 60), 30_000, 600, 120);
    expect(result.totalHeight).toBe(60_000);
    expect(result.end - result.start).toBeLessThan(20);
    expect(result.offsetTop).toBe(result.start * 60);
  });

  it("supports mixed group and conversation row heights", () => {
    const result = computeVirtualWindow([32, 60, 60, 32, 60], 90, 80, 0);
    expect(result.start).toBe(1);
    expect(result.end).toBe(4);
    expect(result.offsets).toEqual([0, 32, 92, 152, 184, 244]);
  });

  it("handles an empty list", () => {
    expect(computeVirtualWindow([], 0, 500)).toMatchObject({ start: 0, end: 0, totalHeight: 0 });
  });
});

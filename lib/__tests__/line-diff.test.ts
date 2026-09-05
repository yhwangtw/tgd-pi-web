import { describe, expect, it } from "vitest";
import { diffLines } from "../line-diff";

function check(oldLines: string[], newLines: string[]) {
  const result = diffLines(oldLines, newLines);
  expect(result.filter((line) => line.type !== "added").map((line) => line.text)).toEqual(oldLines);
  expect(result.filter((line) => line.type !== "removed").map((line) => line.text)).toEqual(newLines);
  for (const line of result) {
    expect(line.text).toBe((line.type === "added" ? newLines : oldLines)[line.lineNo - 1]);
  }
  return result;
}

describe("line diff preserves both documents", () => {
  it("shows the inserted content, not a duplicate of the first line", () => {
    expect(check(["A", "B", "C"], ["A", "X", "B", "C"]).filter((line) => line.type === "added").map((line) => line.text)).toEqual(["X"]);
  });
  it("shows the actual replacement", () => {
    expect(check(["A", "B", "C"], ["A", "Z", "C"]).filter((line) => line.type !== "unchanged").map((line) => line.text)).toEqual(["B", "Z"]);
  });
  it.each([
    [[], []], [[], ["x"]], [["x"], []],
    [[""], ["", ""]], [["A\r", "B\r"], ["A\r", "C\r"]],
    [["a", "a", "b"], ["a", "b", "b"]],
  ])("handles empty documents, trailing newlines, CRLF and duplicates", (oldLines, newLines) => { check(oldLines, newLines); });
  it("reconstructs 300 deterministic edits", () => {
    let seed = 0x4129;
    const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    for (let n = 0; n < 300; n++) {
      const oldLines = Array.from({ length: random(25) }, () => String(random(8)));
      const newLines = Array.from({ length: random(25) }, () => String(random(8)));
      check(oldLines, newLines);
    }
  });
  it("preserves distant edits in a 20k line file", () => {
    const oldLines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const newLines = [...oldLines];
    newLines.splice(10_274, 0, "metadata one");
    newLines.splice(15_247, 0, "metadata two");
    check(oldLines, newLines);
  });
  it("bounds a completely replaced large file without losing content", () => {
    check(
      Array.from({ length: 10_000 }, (_, i) => `before ${i}`),
      Array.from({ length: 10_000 }, (_, i) => `after ${i}`),
    );
  });
});

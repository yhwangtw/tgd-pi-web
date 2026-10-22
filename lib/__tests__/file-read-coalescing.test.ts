import { describe, expect, it } from "vitest";
import type { Stats } from "node:fs";
import { coalesceFileRead } from "../file-read-coalescing";
const stat = { dev: 1, ino: 1, size: 10, mtimeMs: 1, ctimeMs: 1, mode: 0o600 } as Stats;
const roots = new Set(["/fixture"]);

describe("overlapping file reads", () => {
  it("bounds retained keys and releases completed or failed requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let count = 0;
    const read = () => { count++; return gate.then(() => "ok"); };
    const requests = Array.from({ length: 65 }, (_, index) => coalesceFileRead("text", `/fixture/${index}`, stat, roots, read));
    const duplicate = coalesceFileRead("text", "/fixture/0", stat, roots, read);
    const overflow = coalesceFileRead("text", "/fixture/64", stat, roots, read);
    expect(count).toBe(66);
    release(); await Promise.all([...requests, duplicate, overflow]);
    await coalesceFileRead("text", "/fixture/0", stat, roots, async () => { count++; return "new"; });
    expect(count).toBe(67);
    await expect(coalesceFileRead("text", "/fixture/error", stat, roots, async () => { throw new Error("temporary"); })).rejects.toThrow("temporary");
    expect(await coalesceFileRead("text", "/fixture/error", stat, roots, async () => "retry")).toBe("retry");
  });

  it("never shares across file revisions, preview kinds, or different root policies", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let count = 0;
    const read = () => { count++; return gate; };
    const requests = [
      coalesceFileRead("text", "/fixture/a", stat, roots, read),
      coalesceFileRead("html", "/fixture/a", stat, roots, read),
      coalesceFileRead("text", "/fixture/a", { ...stat, ctimeMs: 2 } as Stats, roots, read),
      coalesceFileRead("text", "/fixture/a", stat, new Set(["/fixture/a"]), read),
    ];
    expect(count).toBe(4);
    release(); await Promise.all(requests);
  });
});

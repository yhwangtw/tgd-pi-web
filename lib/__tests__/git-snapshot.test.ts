import { describe, expect, it } from "vitest";
import { parseSnapshotDiff } from "../git-snapshot";

describe("parseSnapshotDiff", () => {
  it("describes modified and deleted files as restores, and new files as removals", () => {
    expect(parseSnapshotDiff("M\0src/app.ts\0D\0old.md\0A\0new.txt\0")).toEqual([
      { path: "src/app.ts", action: "restore", status: "M" },
      { path: "old.md", action: "restore", status: "D" },
      { path: "new.txt", action: "remove", status: "A" },
    ]);
  });

  it("expands a rename into the two changes the restore will perform", () => {
    expect(parseSnapshotDiff("R100\0before.ts\0after.ts\0")).toEqual([
      { path: "after.ts", action: "remove", status: "R" },
      { path: "before.ts", action: "restore", status: "R" },
    ]);
  });

  it("removes only the destination of a copied file", () => {
    expect(parseSnapshotDiff("C090\0source.ts\0copy.ts\0")).toEqual([
      { path: "copy.ts", action: "remove", status: "C" },
    ]);
  });
});

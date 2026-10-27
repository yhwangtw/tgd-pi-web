import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => runtime.dir }));
import { getSessionReadSnapshot, saveSessionReadReceipts } from "../session-read-store";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pi-reads-")); runtime.dir = root; });
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("persists monotonic content positions including ties and concurrent sessions", () => {
  saveSessionReadReceipts({ a: { timestamp: 2000, entryId: "a2", position: 3 } });
  saveSessionReadReceipts({ b: { timestamp: 1000, entryId: "b1", position: 1 }, a: { timestamp: 1000, entryId: "a1", position: 1 } });
  saveSessionReadReceipts({ a: { timestamp: 2000, entryId: "a3", position: 4 } });
  saveSessionReadReceipts({ a: { timestamp: 2000, entryId: "a2", position: 3 } });
  expect(getSessionReadSnapshot().receipts).toEqual({ a: { timestamp: 2000, entryId: "a3", position: 4 }, b: { timestamp: 1000, entryId: "b1", position: 1 } });
  expect(JSON.parse(readFileSync(join(root, "session-reads.json"), "utf8")).version).toBe(1);
});
it("isolates agent directories and does not overwrite a corrupt store", () => {
  const first = saveSessionReadReceipts({ a: { timestamp: 10, entryId: "a" } });
  runtime.dir = join(root, "preview");
  const other = getSessionReadSnapshot();
  expect(other.scope).not.toBe(first.scope); expect(other.receipts).toEqual({});
  runtime.dir = root;
  writeFileSync(join(root, "session-reads.json"), "broken");
  expect(() => saveSessionReadReceipts({ b: { timestamp: 20, entryId: "b" } })).toThrow();
  expect(readFileSync(join(root, "session-reads.json"), "utf8")).toBe("broken");
});

import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/sessions/analytics/route";

const state = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("@/lib/session-reader", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/session-reader")>(),
  listAllSessions: async () => [...state.files.keys()].map(id => ({ id, cwd: "/fixture", created: "2026-01-01", modified: "2026-09-05", messageCount: 1 })),
  resolveSessionPath: async (id: string) => state.files.get(id),
}));
let fixtureRoot = "";
afterEach(() => {
  state.files.clear();
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

it("reports unreadable history without rewriting empty/corrupt session files", async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "analytics-read-only-"));
  const valid = [
    { type: "session", version: 3, id: "valid", cwd: fixtureRoot, timestamp: "2026-01-01T00:00:00Z" },
    { type: "message", id: "response", parentId: null, timestamp: "2026-02-01T00:00:00Z", message: { role: "assistant", provider: "fixture", model: "same", usage: { input: 1 } } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  const originals = new Map<string, { content: string; mtime: number }>();
  for (const [id, content] of [["valid", valid], ["empty", ""], ["corrupt", "not-json\n"]]) {
    const file = join(fixtureRoot, `${id}.jsonl`);
    writeFileSync(file, content);
    state.files.set(id, file);
    originals.set(file, { content, mtime: statSync(file).mtimeMs });
  }
  const response = await GET();
  expect(response.status).toBe(200);
  const report = await response.json();
  expect(report.summary.sessionCount).toBe(1);
  expect(report.scope.skippedSessions).toBe(2);
  expect(report.summary.coverage.missingCost).toBe(1);
  for (const [file, before] of originals) {
    expect(readFileSync(file, "utf8")).toBe(before.content);
    expect(statSync(file).mtimeMs).toBe(before.mtime);
  }
});

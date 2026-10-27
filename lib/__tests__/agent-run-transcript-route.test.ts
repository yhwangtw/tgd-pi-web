import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "../agent-run-types";
import type { SessionEntry } from "../types";

const harness = vi.hoisted(() => ({
  runs: [] as AgentRun[],
  filePath: null as string | null,
  live: undefined as { sessionId: string; isAlive: () => boolean; inner: { sessionManager: { getEntries: () => SessionEntry[] } } } | undefined,
  resolvePath: vi.fn(),
}));
vi.mock("@/lib/agent-run-store", () => ({ readAgentRunStore: () => ({ runs: harness.runs }) }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: () => harness.live }));
vi.mock("@/lib/session-migrations", () => ({ resolveMigratedSessionId: (id: string) => id === "old-alias" ? "sdk-session" : id }));
vi.mock("@/lib/session-reader", async importOriginal => ({
  ...await importOriginal<typeof import("../session-reader")>(),
  resolveSessionPath: harness.resolvePath,
}));

import { GET } from "../../app/api/agent-runs/[id]/transcript/route";

const dirs: string[] = [];
function entries(count = 2): SessionEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
    type: "message", timestamp: "2026-10-26T00:00:00.000Z",
    message: { role: "user", content: `message ${index}` },
  } as SessionEntry));
}
const get = (id = "run-1") => GET(new Request(`http://localhost/api/agent-runs/${id}/transcript`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  harness.runs = [{ id: "run-1", name: "Review", cwd: "/work", prompt: "Review", trigger: "manual", status: "running", toolNames: ["read"],
    createdAt: "2026-10-26T00:00:00.000Z", sessionId: "sdk-session" }];
  harness.live = undefined;
  harness.filePath = null;
  harness.resolvePath.mockReset();
  harness.resolvePath.mockImplementation(async () => harness.filePath);
});
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("agent run transcript", () => {
  it("reads a saved SDK transcript through an alias without modifying the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-run-transcript-")); dirs.push(dir);
    harness.filePath = join(dir, "session.jsonl");
    const source = [{ type: "session", version: 3, id: "sdk-session", cwd: "/work", timestamp: "2026-10-26T00:00:00.000Z" }, ...entries()].map(value => JSON.stringify(value)).join("\n") + "\n";
    writeFileSync(harness.filePath, source);
    harness.runs[0].sessionId = "old-alias";
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messages: [{ role: "user", content: "message 0" }, { role: "user", content: "message 1" }], truncated: false });
    expect(harness.resolvePath).toHaveBeenCalledWith("sdk-session");
    expect(readFileSync(harness.filePath, "utf8")).toBe(source);
  });

  it("keeps background-run history before compaction", async () => {
    const history = entries(2);
    history.push({ id: "compact", type: "compaction", parentId: "entry-1", timestamp: "2026-10-27T00:00:00Z", summary: "Summary", firstKeptEntryId: "entry-1", tokensBefore: 40000 });
    harness.live = { sessionId: "sdk-session", isAlive: () => true, inner: { sessionManager: { getEntries: () => history } } };
    const response = await get(); const body = await response.json();
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0].content).toBe("message 0");
    expect(body.messages[2]).toMatchObject({ role: "custom", customType: "pi-web-compaction" });
  });

  it("reads an unsaved live SDK session and bounds the transcript", async () => {
    harness.live = { sessionId: "sdk-session", isAlive: () => true, inner: { sessionManager: { getEntries: () => entries(405) } } };
    const response = await get();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.messages).toHaveLength(400);
    expect(body.messages[0].content).toBe("message 5");
    expect(body.truncated).toBe(true);
  });

  it("returns an empty queued transcript and explicit missing-run/session errors", async () => {
    harness.runs[0].sessionId = undefined;
    expect(await (await get()).json()).toMatchObject({ messages: [], truncated: false });
    expect((await get("missing")).status).toBe(404);
    harness.runs[0].sessionId = "missing-session";
    expect((await get()).status).toBe(404);
  });
});

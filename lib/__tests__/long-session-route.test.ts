import { describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionTreeNode } from "../types";
import { decodeSessionData } from "../session-tree-wire";

const fixture = vi.hoisted(() => ({ entries: [] as unknown[], id: "legacy" }));
vi.mock("@/lib/session-migrations", () => ({ waitForSessionMigration: async (id: string) => id }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: () => undefined }));
vi.mock("@/lib/session-reader", async importOriginal => ({
  ...await importOriginal<typeof import("../session-reader")>(),
  resolveSessionPath: async () => "/fixture/session.jsonl",
  readSessionFile: () => ({ header: { id: fixture.id, cwd: "/fixture", timestamp: "2026-10-22T00:00:00Z" }, entries: fixture.entries }),
  listAllSessions: async () => [],
}));
import { GET } from "@/app/api/sessions/[id]/route";

describe("long conversation detail responses", () => {
  it.each([
    ["legacy", "flat-v1"], ["legacy", "flat-v2"], ["converted", "flat-v1"], ["converted", "flat-v2"],
  ])("returns all 10,000 %s messages with %s without HTTP 500", async (engine, format) => {
    const id = engine === "legacy" ? "legacy" : "dw_00000000-0000-0000-0000-000000000000_1";
    const messages = Array.from({ length: 10_000 }, (_, i) => ({ role: "user" as const, content: `Synthetic turn ${i}`, timestamp: i + 1 }));
    fixture.entries = messages.map((message, i): SessionEntry => ({ type: "message", id: String(i + 1), parentId: i ? String(i) : null, timestamp: new Date(i + 1).toISOString(), message }));
    fixture.id = id;
    const response = await GET(new Request("http://localhost/?includeState", { headers: { "X-Pi-Session-Tree": format } }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBe("X-Pi-Session-Tree");
    const wire = await response.json();
    expect(wire.tree.format).toBe(format);
    if (format === "flat-v2") expect(wire.tree.nodes.some((node: object) => "contextMessage" in node)).toBe(true);
    const body = decodeSessionData(wire);
    expect(body.context.messages).toHaveLength(10_000);
    expect(body.context.messages.at(-1).content).toBe("Synthetic turn 9999");
    let count = 0; let leaf: string | undefined;
    for (let node: SessionTreeNode | undefined = body.tree[0]; node; node = node.children[0]) { count++; leaf = node.entry.id; }
    expect(count).toBe(10_000); expect(leaf).toBe(body.leafId);
    expect(body.agentState.running).toBe(false);
  });

  it("keeps the nested shape for an already-loaded legacy client", async () => {
    fixture.id = "legacy";
    fixture.entries = [{ type: "message", id: "one", parentId: null, timestamp: "2026-10-22T00:00:00Z", message: { role: "user", content: "old tab", timestamp: 1 } }];
    const response = await GET(new Request("http://localhost/"), { params: Promise.resolve({ id: "legacy" }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.tree[0].entry.id).toBe("one");
  });
});

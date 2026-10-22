import { describe, expect, it, vi } from "vitest";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { SessionEntry, SessionTreeNode } from "../types";
import { durableContext, type DurableSessionProjection } from "../durable-session-store";
import { decodeSessionData } from "../session-tree-wire";

const fixture = vi.hoisted(() => ({ entries: [] as unknown[], projection: undefined as unknown }));
vi.mock("@/lib/durable-migration", () => ({ waitForSessionMigration: async (id: string) => id }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: () => undefined }));
vi.mock("@/lib/durable-chat", () => ({ getDurableChat: () => undefined, openDurableChat: () => { throw new Error("Read must not resume an agent"); } }));
vi.mock("@/lib/session-reader", async importOriginal => ({
  ...await importOriginal<typeof import("../session-reader")>(),
  resolveSessionPath: async () => "/fixture/session.jsonl",
  readSessionFile: () => ({ header: { id: "legacy", cwd: "/fixture", timestamp: "2026-10-22T00:00:00Z" }, entries: fixture.entries }),
  listAllSessions: async () => [],
}));
vi.mock("@/lib/durable-session-store", async importOriginal => ({
  ...await importOriginal<typeof import("../durable-session-store")>(),
  readDurableProjection: () => fixture.projection,
}));
import { GET } from "@/app/api/sessions/[id]/route";

describe("long conversation detail responses", () => {
  it.each(["legacy", "durable"])("returns all 10,000 %s messages and a readable tree without HTTP 500", async engine => {
    const id = engine === "legacy" ? "legacy" : "dw_00000000-0000-0000-0000-000000000000_1";
    const messages = Array.from({ length: 10_000 }, (_, i) => ({ role: "user" as const, content: `Synthetic turn ${i}`, timestamp: i + 1 }));
    fixture.entries = messages.map((message, i): SessionEntry => ({ type: "message", id: String(i + 1), parentId: i ? String(i) : null, timestamp: new Date(i + 1).toISOString(), message }));
    const entries: EntryRecord[] = messages.map((message, i) => ({ id: (i + 1) as EntryId, conversationId: 1 as ConversationId, kind: "pi.user", model: [message] }));
    fixture.projection = { version: 1, deleted: false, entries, agent: {}, context: durableContext(entries, {}),
      info: { id, path: "/fixture", cwd: "/fixture", created: "2026-10-22T00:00:00Z", modified: "2026-10-22T00:00:00Z", messageCount: messages.length, firstMessage: "Synthetic turn 0" } } satisfies DurableSessionProjection;
    const response = await GET(new Request("http://localhost/?includeState", { headers: { "X-Pi-Session-Tree": "flat-v1" } }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    const body = decodeSessionData(await response.json());
    expect(body.context.messages).toHaveLength(10_000);
    expect(body.context.messages.at(-1).content).toBe("Synthetic turn 9999");
    let count = 0; let leaf: string | undefined;
    for (let node: SessionTreeNode | undefined = body.tree[0]; node; node = node.children[0]) { count++; leaf = node.entry.id; }
    expect(count).toBe(10_000); expect(leaf).toBe(body.leafId);
    expect(body.agentState.running).toBe(false);
  });

  it("keeps the nested shape for an already-loaded legacy client", async () => {
    fixture.entries = [{ type: "message", id: "one", parentId: null, timestamp: "2026-10-22T00:00:00Z", message: { role: "user", content: "old tab", timestamp: 1 } }];
    const response = await GET(new Request("http://localhost/"), { params: Promise.resolve({ id: "legacy" }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.tree[0].entry.id).toBe("one");
  });
});

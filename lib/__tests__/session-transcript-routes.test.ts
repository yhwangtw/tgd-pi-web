import { describe, expect, it, vi } from "vitest";
import { buildSessionContext as sdkContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry as PiEntry } from "@earendil-works/pi-coding-agent";
import { decodeSessionData } from "../session-tree-wire";
import type { SessionEntry } from "../types";

const fixture = vi.hoisted(() => ({ entries: [] as SessionEntry[] }));
vi.mock("@/lib/session-migrations", () => ({ waitForSessionMigration: async (id: string) => id, resolveMigratedSessionId: (id: string) => id }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: () => undefined }));
vi.mock("@/lib/session-reader", async importOriginal => ({
  ...await importOriginal<typeof import("../session-reader")>(),
  resolveSessionPath: async () => "/fixture/compact.jsonl",
  readSessionFile: () => ({ header: { id: "compacted", cwd: "/fixture", timestamp: "2026-10-27T00:00:00Z" }, entries: fixture.entries }),
  getSessionEntries: () => fixture.entries,
}));
import { GET as getSession } from "@/app/api/sessions/[id]/route";
import { GET as getContext } from "@/app/api/sessions/[id]/context/route";
const t = "2026-10-27T00:00:00Z";
const params = { params: Promise.resolve({ id: "compacted" }) };
function seed() {
  fixture.entries = [
    { type: "message", id: "old", parentId: null, timestamp: t, message: { role: "user", content: "Original question" } },
    { type: "message", id: "kept", parentId: "old", timestamp: t, message: { role: "user", content: "Recent question" } },
    { type: "compaction", id: "compact", parentId: "kept", timestamp: t, summary: "History summary", firstKeptEntryId: "kept", tokensBefore: 40000 },
    { type: "message", id: "new", parentId: "compact", timestamp: t, message: { role: "user", content: "Newest question" } },
  ];
}

describe("compacted history read APIs", () => {
  it.each(["nested", "flat-v1", "flat-v2"])("reloads all original messages with %s transport without rewriting history or model context", async format => {
    seed(); const before = JSON.stringify(fixture.entries); const modelBefore = sdkContext(fixture.entries as PiEntry[]);
    const response = await getSession(new Request("http://localhost/?includeState", { headers: format === "nested" ? {} : { "X-Pi-Session-Tree": format } }), params);
    expect(response.status).toBe(200);
    const body = decodeSessionData(await response.json());
    expect(body.context.entryIds).toEqual(["old", "kept", "compact", "new"]);
    expect(body.info.firstMessage).toBe("Original question");
    expect(body.context.messages.filter((m: { role: string }) => m.role === "user")).toHaveLength(3);
    expect(sdkContext(fixture.entries as PiEntry[])).toEqual(modelBefore);
    expect(JSON.stringify(fixture.entries)).toBe(before);
  });
  it("switches between full-history branches and historical leaves without cross-branch leakage", async () => {
    seed(); fixture.entries.push({ type: "message", id: "sibling", parentId: "old", timestamp: t, message: { role: "user", content: "Other branch" } });
    for (const [leaf, ids] of [["new", ["old", "kept", "compact", "new"]], ["sibling", ["old", "sibling"]], ["kept", ["old", "kept"]]] as const) {
      const response = await getContext(new Request(`http://localhost/context?leafId=${leaf}`), params);
      expect(response.status).toBe(200);
      expect((await response.json()).context.entryIds).toEqual(ids);
    }
  });
});

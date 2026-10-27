import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionWrapper } from "../rpc-manager";

const fixture = vi.hoisted(() => ({ live: undefined as AgentSessionWrapper | undefined }));
vi.mock("@/lib/session-migrations", () => ({ waitForSessionMigration: async (id: string) => id, resolveMigratedSessionId: (id: string) => id }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: () => fixture.live }));
vi.mock("@/lib/session-reader", async importOriginal => ({
  ...await importOriginal<typeof import("../session-reader")>(),
  resolveSessionPath: async () => "/fixture/policy.jsonl",
  readSessionFile: () => ({ header: { id: "policy", cwd: "/fixture", timestamp: "2026-10-28T00:00:00Z" }, entries: [{ type: "model_change", id: "model", parentId: null, timestamp: "2026-10-28T00:00:00Z", provider: "fixture", modelId: "saved" }] }),
}));
import { GET } from "@/app/api/sessions/[id]/route";
const request = () => GET(new Request("http://localhost/"), { params: Promise.resolve({ id: "policy" }) });
afterEach(() => { fixture.live = undefined; vi.restoreAllMocks(); });

describe("session detail compaction settings", () => {
  it("resolves saved sessions against the historical model override", async () => {
    const manager = SettingsManager.inMemory({ compaction: { modelOverrides: { "fixture/saved": { reserveTokens: 8_192, keepRecentTokens: 12_000 } } } });
    vi.spyOn(SettingsManager, "create").mockReturnValue(manager);
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json()).compactionSettings).toEqual({ enabled: true, reserveTokens: 8_192, keepRecentTokens: 12_000 });
  });
  it("uses the live settings manager and current model over persisted history", async () => {
    const manager = SettingsManager.inMemory({ compaction: { enabled: false, modelOverrides: { "fixture/current": { reserveTokens: 32_768 } } } });
    fixture.live = { isAlive: () => true, inner: { model: { provider: "fixture", id: "current" }, settingsManager: manager } } as unknown as AgentSessionWrapper;
    const create = vi.spyOn(SettingsManager, "create");
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json()).compactionSettings).toEqual({ enabled: false, reserveTokens: 32_768, keepRecentTokens: 20_000 });
    expect(create).not.toHaveBeenCalled();
  });
});

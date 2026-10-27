import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ path: vi.fn(), read: vi.fn(), live: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/session-reader", () => ({ resolveSessionPath: mocks.path, readSessionFile: mocks.read }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: mocks.live }));
vi.mock("@/lib/session-migrations", () => ({ resolveMigratedSessionId: (id: string) => id }));
vi.mock("@/lib/session-read-store", () => ({ saveSessionReadReceipts: mocks.save, getSessionReadSnapshot: () => ({ scope: "test", receipts: {} }) }));
import { POST } from "@/app/api/sessions/reads/route";
function request(body: unknown, origin = "http://localhost:30177") {
  return new Request("http://localhost:30177/api/sessions/reads", { method: "POST", headers: { origin, host: "localhost:30177", "Content-Type": "application/json" }, body: JSON.stringify({ scope: "test", ...(body as object) }) });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.path.mockResolvedValue("/fixture.jsonl"); mocks.live.mockReturnValue(undefined);
  mocks.save.mockImplementation((receipts: unknown) => ({ scope: "test", receipts }));
  mocks.read.mockReturnValue({ entries: [
    { type: "session_info", id: "name", timestamp: "2026-01-01T00:00:00Z" },
    { type: "message", id: "q", message: { role: "user", timestamp: 1000 } },
    { type: "message", id: "a", message: { role: "assistant", timestamp: 2000 } },
  ] });
});
it("derives positions and timestamps from actual messages, ignores forged values and merges duplicate IDs", async () => {
  const response = await POST(request({ receipts: [ { id: "one", entryId: "a", timestamp: 9999999, position: 9999 }, { id: "one", entryId: "q" } ] }));
  expect(response.status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith({ one: { timestamp: 2000, entryId: "a", position: 2 } });
});
it("rejects unknown and non-message entries without manufacturing progress", async () => {
  const response = await POST(request({ receipts: [{ id: "one", entryId: "missing" }, { id: "two", entryId: "name" }] }));
  expect((await response.json()).rejected).toEqual(["one", "two"]);
  expect(mocks.save).toHaveBeenCalledWith({});
});
it("accepts in-memory sessions before persistence without opening or writing a transcript", async () => {
  mocks.live.mockReturnValue({ isAlive: () => true, sessionId: "one", inner: { sessionManager: { getEntries: () => mocks.read().entries } } });
  const response = await POST(request({ receipts: [{ id: "one", entryId: "a" }] }));
  expect(response.status).toBe(200); expect(mocks.path).not.toHaveBeenCalled();
});
it("bounds payloads and rejects cross-origin writes", async () => {
  expect((await POST(request({ receipts: [] }))).status).toBe(400);
  expect((await POST(request({ receipts: [{ id: "../bad", entryId: "a" }] }))).status).toBe(400);
  expect((await POST(request({ receipts: [], padding: "a".repeat(33000) }))).status).toBe(413);
  expect((await POST(request({ receipts: [{ id: "one", entryId: "a" }] }, "https://evil.test"))).status).toBe(403);
  expect(mocks.save).not.toHaveBeenCalled();
});

it("rejects an old tab's writes after the origin changes backend", async () => {
  expect((await POST(request({ scope: "old-preview", receipts: [{ id: "one", entryId: "a" }] }))).status).toBe(409);
  expect(mocks.path).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});

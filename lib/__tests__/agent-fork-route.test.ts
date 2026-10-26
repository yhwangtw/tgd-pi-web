import { beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn(), resolve: vi.fn(), start: vi.fn(), open: vi.fn(), alias: vi.fn(async (id: string) => id) }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: harness.get, startRpcSession: harness.start }));
vi.mock("@/lib/session-reader", () => ({ resolveSessionPath: harness.resolve }));
vi.mock("@/lib/session-migrations", () => ({ waitForSessionMigration: harness.alias }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ SessionManager: { open: harness.open } }));
import { POST } from "../../app/api/agent/[id]/route";

beforeEach(() => {
  vi.clearAllMocks();
  harness.alias.mockImplementation(async (id: string) => id);
});

it.each(["standard", "dw_00000000-0000-0000-0000-000000000000_1"])("sends prompts directly to the existing SDK session %s", async id => {
  harness.get.mockReturnValue({ isAlive: () => true, send: harness.send });
  harness.send.mockResolvedValue({ ok: true });
  const response = await POST(new Request(`http://localhost/api/agent/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "prompt", message: "hello" }) }), { params: Promise.resolve({ id }) });
  expect(await response.json()).toEqual({ success: true, data: { ok: true } });
  expect(harness.get).toHaveBeenCalledWith(id);
  expect(harness.send).toHaveBeenCalledWith({ type: "prompt", message: "hello" });
  expect(harness.resolve).not.toHaveBeenCalled();
  expect(harness.start).not.toHaveBeenCalled();
});

it("routes old aliases to their SDK session without starting a conversion", async () => {
  harness.alias.mockResolvedValue("dw_00000000-0000-0000-0000-000000000000_1");
  harness.get.mockReturnValue({ isAlive: () => true, send: harness.send });
  harness.send.mockResolvedValue(null);
  const response = await POST(new Request("http://localhost/api/agent/old", { method: "POST", body: JSON.stringify({ type: "prompt", message: "continue" }) }), { params: Promise.resolve({ id: "old" }) });
  expect(response.status).toBe(200);
  expect(harness.get).toHaveBeenCalledWith("dw_00000000-0000-0000-0000-000000000000_1");
  expect(harness.start).not.toHaveBeenCalled();
});

it("deduplicates fork retries before looking up or reopening the replaced runtime", async () => {
  const request = () => new Request("http://localhost/api/agent/old", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "a1234567-1234-4123-8123-123456789abc" },
    body: JSON.stringify({ type: "fork", entryId: "entry-1" }),
  });
  harness.get.mockReturnValue({ isAlive: () => true, send: harness.send });
  harness.send.mockImplementation(async () => {
    harness.get.mockReturnValue(undefined);
    return { cancelled: false, newSessionId: "next", selectedText: "hello" };
  });
  const responses = await Promise.all([POST(request(), { params: Promise.resolve({ id: "old" }) }), POST(request(), { params: Promise.resolve({ id: "old" }) })]);
  for (const response of responses) expect(await response.json()).toMatchObject({ success: true, data: { newSessionId: "next" } });
  expect(harness.get).toHaveBeenCalledOnce();
  expect(harness.send).toHaveBeenCalledOnce();
  expect(harness.resolve).not.toHaveBeenCalled();
  expect(harness.start).not.toHaveBeenCalled();
  expect(harness.open).not.toHaveBeenCalled();
});

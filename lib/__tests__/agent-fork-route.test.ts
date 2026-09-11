import { expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn(), resolve: vi.fn(), start: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: harness.get, startRpcSession: harness.start }));
vi.mock("@/lib/session-reader", () => ({ resolveSessionPath: harness.resolve }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ SessionManager: { open: harness.open } }));
import { POST } from "../../app/api/agent/[id]/route";

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

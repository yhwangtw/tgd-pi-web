import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ stream: vi.fn(), append: vi.fn(), name: vi.fn() }));
vi.mock("@/lib/durable-migration", () => ({ waitForSessionMigration: async (id: string) => id }));
vi.mock("@/lib/durable-chat", () => ({ openDurableChat: vi.fn() }));
vi.mock("@/lib/durable-session-store", () => ({ isDurableSessionId: () => false }));
vi.mock("@/lib/session-reader", () => ({ readSessionCwd: vi.fn() }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: () => ({ isAlive: () => true, modelRegistry: { find: () => ({ id: "model", provider: "test" }) }, inner: {
  model: { id: "model", provider: "test" }, sessionManager: { getSessionName: mocks.name, appendSessionInfo: mocks.append },
  agent: { streamFn: mocks.stream, state: { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] } },
} }), startRpcSession: vi.fn() }));
import { POST } from "../../app/api/agent/[id]/summarize/route";
const params = { params: Promise.resolve({ id: "standard" }) };
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.name.mockReturnValue(undefined); });
afterEach(() => vi.useRealTimers());
function pendingResult() {
  mocks.stream.mockImplementation(async (_model, _context, { signal }: { signal: AbortSignal }) => ({ result: () => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) }));
}
describe("Standard title cancellation", () => {
  it("keeps timeout active until the provider result settles", async () => {
    pendingResult();
    const response = POST(new Request("http://localhost"), params);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await response).status).toBe(504);
    expect(mocks.stream.mock.calls[0][2].signal.aborted).toBe(true);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("passes browser cancellation through to the provider and does not rename", async () => {
    pendingResult(); const abort = new AbortController();
    const response = POST(new Request("http://localhost", { signal: abort.signal }), params);
    await vi.advanceTimersByTimeAsync(0); abort.abort();
    expect((await response).status).toBe(499);
    expect(mocks.append).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start a request already cancelled", async () => {
    const response = await POST(new Request("http://localhost", { signal: AbortSignal.abort() }), params);
    expect(response.status).toBe(499); expect(mocks.stream).not.toHaveBeenCalled();
  });
  it("saves a completed title and clears its timer", async () => {
    mocks.stream.mockResolvedValue({ result: async () => ({ content: [{ type: "text", text: "Short title" }] }) });
    const response = await POST(new Request("http://localhost"), params);
    expect(await response.json()).toEqual({ name: "Short title" });
    expect(mocks.append).toHaveBeenCalledWith("Short title"); expect(vi.getTimerCount()).toBe(0);
  });
});

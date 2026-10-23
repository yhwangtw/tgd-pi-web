import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
const mocks = vi.hoisted(() => ({ create: vi.fn(), login: vi.fn(), rpc: vi.fn(), durable: vi.fn() }));
vi.mock("@/lib/pi-model-runtime", () => ({ createPiModelRuntime: mocks.create }));
vi.mock("@/lib/rpc-manager", () => ({ invalidateRpcSessionsForAuthChange: mocks.rpc }));
vi.mock("@/lib/durable-chat", () => ({ invalidateDurableSessionsForAuthChange: mocks.durable }));
import { GET } from "../../app/api/auth/login/[provider]/route";
const params = { params: Promise.resolve({ provider: "fixture" }) };
beforeEach(() => { vi.clearAllMocks(); mocks.create.mockResolvedValue({ getProvider: () => ({ auth: { oauth: true } }), login: mocks.login }); mocks.durable.mockResolvedValue({ restarted: 0, deferred: 0 }); });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
describe("OAuth stream cleanup", () => {
  it("aborts pending provider work and closes a disconnected request", async () => {
    let signal: AbortSignal | undefined;
    mocks.login.mockImplementation(async (_provider, _method, interaction: AuthInteraction) => {
      signal = interaction.signal;
      await interaction.prompt({ type: "text", message: "Code" });
    });
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost", { signal: abort.signal }), params);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    abort.abort();
    expect((await reader.read()).done).toBe(true);
    await flush();
    expect(signal?.aborted).toBe(true); expect(globalThis.__piLoginCallbacks?.size ?? 0).toBe(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("handles consumer cancellation without writing to a closed stream", async () => {
    let interaction: AuthInteraction | undefined;
    mocks.login.mockImplementation(async (_provider, _method, value: AuthInteraction) => {
      interaction = value;
      await value.prompt({ type: "text", message: "Code" });
    });
    const response = await GET(new Request("http://localhost"), params);
    const reader = response.body!.getReader(); await reader.read(); await reader.cancel(); await flush();
    expect(interaction?.signal?.aborted).toBe(true);
    expect(globalThis.__piLoginCallbacks?.size ?? 0).toBe(0);
  });
  it("closes initialization errors and skips initialization after early abort", async () => {
    mocks.create.mockRejectedValueOnce(new Error("fixture unavailable"));
    const response = await GET(new Request("http://localhost"), params);
    expect(await response.text()).toContain("fixture unavailable");
    const aborted = await GET(new Request("http://localhost", { signal: AbortSignal.abort() }), params);
    expect(await aborted.text()).toBe(""); expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("invalidates both runtimes after successful login", async () => {
    mocks.login.mockResolvedValue(undefined);
    const response = await GET(new Request("http://localhost"), params);
    expect(await response.text()).toContain('"success"');
    expect(mocks.rpc).toHaveBeenCalledTimes(1); expect(mocks.durable).toHaveBeenCalledTimes(1);
  });
});

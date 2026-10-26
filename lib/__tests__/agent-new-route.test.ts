import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ start: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/rpc-manager", () => ({ startRpcSession: harness.start }));
import { POST } from "../../app/api/agent/new/route";

const cwd = mkdtempSync(join(tmpdir(), "pi-ephemeral-route-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
beforeEach(() => {
  harness.start.mockReset(); harness.send.mockReset();
  harness.send.mockResolvedValue(null);
  harness.start.mockResolvedValue({ session: { send: harness.send }, realSessionId: "memory-1" });
});

describe("POST /api/agent/new", () => {
  it.each([undefined, "sdk", "legacy"])("uses the SDK for engine %s", async engine => {
    const response = await POST(new Request("http://localhost/api/agent/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, engine, deferPrompt: true }) }));
    expect(response.status).toBe(200);
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it.each(["durable", "other"])("rejects the unsupported engine %s before creating a session", async engine => {
    const response = await POST(new Request("http://localhost/api/agent/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, engine, deferPrompt: true }) }));
    expect(response.status).toBe(400);
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("can create and configure a session without starting its first prompt", async () => {
    const response = await POST(new Request("http://localhost/api/agent/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, type: "prompt", message: "instant answer", deferPrompt: true, provider: "test", modelId: "fast" }) }));
    expect(response.status).toBe(200);
    expect(harness.send).toHaveBeenCalledExactlyOnceWith({ type: "set_model", provider: "test", modelId: "fast" });
    await expect(response.json()).resolves.toMatchObject({ sessionId: "memory-1", deferred: true });
  });

  it("creates an in-memory Pi runtime when ephemeral is selected", async () => {
    const response = await POST(new Request("http://localhost/api/agent/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, type: "prompt", message: "hello", ephemeral: true }) }));
    expect(response.status).toBe(200);
    expect(harness.start).toHaveBeenCalledWith(expect.stringMatching(/^__new__/), "", cwd, undefined, { ephemeral: true });
    await expect(response.json()).resolves.toMatchObject({ sessionId: "memory-1", ephemeral: true });
  });
});

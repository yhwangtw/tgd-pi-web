import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendAgentCommand } from "../agent-client";

describe("sendAgentCommand", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs JSON to /api/agent/<sessionId> and returns data on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const result = await sendAgentCommand<{ ok: boolean }>("session-1", { type: "ping" });

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/agent/session-1");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ type: "ping" });
  });

  it("encodes session ids that contain special characters", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: null }),
    });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    await sendAgentCommand("session/with/slashes", { type: "ping" });

    const [url] = mockFetch.mock.calls[0];
    // encodeURIComponent encodes the slashes
    expect(url).toBe("/api/agent/session%2Fwith%2Fslashes");
  });

  it("gives each deliberate fork a transport-stable request key", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { newSessionId: "next" } }) });
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
    await sendAgentCommand("old", { type: "fork", entryId: "entry-1" });
    await sendAgentCommand("old", { type: "fork", entryId: "entry-1" });
    const keys = mockFetch.mock.calls.map(([, init]) => init.headers["Idempotency-Key"]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("keeps fork retry protection on HTTP LAN origins without randomUUID", async () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    try {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: {} }) });
      globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
      await sendAgentCommand("old", { type: "fork", entryId: "entry-1" });
      expect(mockFetch.mock.calls[0][1].headers["Idempotency-Key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally { vi.unstubAllGlobals(); }
  });

  it("throws when the response is not ok", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    }) as unknown as typeof globalThis.fetch;

    await expect(sendAgentCommand("s1", { type: "x" })).rejects.toThrow("boom");
  });

  it("throws with HTTP status when error body has no message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as unknown as typeof globalThis.fetch;

    await expect(sendAgentCommand("s1", { type: "x" })).rejects.toThrow("HTTP 503");
  });

  it("throws when ok but body contains an error field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: "soft fail" }),
    }) as unknown as typeof globalThis.fetch;

    await expect(sendAgentCommand("s1", { type: "x" })).rejects.toThrow("soft fail");
  });

  it("handles malformed JSON body without throwing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new SyntaxError("Unexpected token"); },
    }) as unknown as typeof globalThis.fetch;

    await expect(sendAgentCommand("s1", { type: "x" })).rejects.toThrow("HTTP 500");
  });
});

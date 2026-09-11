import { describe, expect, it, vi } from "vitest";
import { ForkRequestCache } from "../fork-request-cache";

const key = "12345678-1234-4123-8123-123456789abc";
const command = { type: "fork", entryId: "entry-1" };
const reply = () => Response.json({ success: true, data: { newSessionId: "next", selectedText: "hello" } });

describe("fork request transport deduplication", () => {
  it("executes concurrent and completed retries only once and preserves the response", async () => {
    const cache = new ForkRequestCache();
    const execute = vi.fn(async () => reply());
    const responses = await Promise.all([cache.run("old", key, command, execute), cache.run("old", key, command, execute)]);
    const retry = await cache.run("old", key, command, execute);
    for (const response of [...responses, retry]) expect(await response.json()).toEqual(await reply().json());
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects key reuse with different arguments without another side effect", async () => {
    const cache = new ForkRequestCache();
    const execute = vi.fn(async () => reply());
    await cache.run("old", key, command, execute);
    const conflict = await cache.run("old", key, { ...command, entryId: "entry-2" }, execute);
    expect(conflict.status).toBe(409);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("scopes keys to the session and caches uncertain failures", async () => {
    const cache = new ForkRequestCache();
    const execute = vi.fn(async () => { throw new Error("uncertain runtime result"); });
    expect((await cache.run("old", key, command, execute)).status).toBe(500);
    expect((await cache.run("old", key, command, execute)).status).toBe(500);
    expect(execute).toHaveBeenCalledOnce();
    await cache.run("other", key, command, execute);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("fails closed at capacity instead of evicting still-valid retry protection", async () => {
    const cache = new ForkRequestCache({ maxEntries: 1 });
    const execute = vi.fn(async () => reply());
    await cache.run("old", key, command, execute);
    expect((await cache.run("other", key, command, execute)).status).toBe(503);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects malformed keys and keeps large completed responses protected", async () => {
    const cache = new ForkRequestCache({ maxResponseBytes: 32 });
    const execute = vi.fn(async () => reply());
    expect((await cache.run("old", "invalid", command, execute)).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect((await cache.run("old", key, command, execute)).status).toBe(200);
    expect((await cache.run("old", key, command, execute)).status).toBe(409);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("retains legacy requests without a key", async () => {
    const execute = vi.fn(async () => reply());
    const cache = new ForkRequestCache();
    await cache.run("old", null, command, execute);
    await cache.run("old", null, command, execute);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("expires completed keys but never expires an in-flight operation", async () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(0);
      const cache = new ForkRequestCache({ ttlMs: 10 });
      let finish!: (response: Response) => void;
      const execute = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
      const first = cache.run("old", key, command, execute);
      now.mockReturnValue(100);
      const duplicate = cache.run("old", key, command, execute);
      expect(execute).toHaveBeenCalledOnce();
      finish(reply());
      await Promise.all([first, duplicate]);
      now.mockReturnValue(111);
      const afterExpiry = vi.fn(async () => reply());
      await cache.run("old", key, command, afterExpiry);
      expect(afterExpiry).toHaveBeenCalledOnce();
    } finally { now.mockRestore(); }
  });
});

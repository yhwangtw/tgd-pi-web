import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRequestSnapshot,
  invalidateRequest,
  loadRequest,
  resetRequestState,
  subscribeRequest,
} from "../request-state";

afterEach(() => resetRequestState());

describe("shared request state", () => {
  it("deduplicates concurrent loads and serves fresh cached data", async () => {
    let resolveRequest!: (value: string) => void;
    const fetcher = vi.fn(() => new Promise<string>((resolve) => { resolveRequest = resolve; }));
    const first = loadRequest("dedupe", fetcher, { staleTimeMs: 60_000 });
    const second = loadRequest("dedupe", fetcher, { staleTimeMs: 60_000 });
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveRequest("ready");
    await expect(first).resolves.toBe("ready");
    await expect(loadRequest("dedupe", fetcher, { staleTimeMs: 60_000 })).resolves.toBe("ready");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries with backoff and records the successful update time", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ ok: true });
    await expect(loadRequest("retry", fetcher, { retries: 1, retryDelayMs: 0 })).resolves.toEqual({ ok: true });
    const snapshot = getRequestSnapshot<{ ok: boolean }>("retry");
    expect(snapshot.status).toBe("success");
    expect(snapshot.attempts).toBe(2);
    expect(snapshot.updatedAt).toEqual(expect.any(Number));
  });

  it("aborts an in-flight request after the last subscriber leaves", async () => {
    const unsubscribe = subscribeRequest("abort", () => undefined);
    const task = loadRequest("abort", (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    unsubscribe();
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    expect(getRequestSnapshot("abort")).toMatchObject({ status: "idle", error: null });
  });

  it("marks cached data stale without discarding the last successful value", async () => {
    await loadRequest("invalidate", async () => "cached");
    invalidateRequest("invalidate");
    expect(getRequestSnapshot("invalidate")).toMatchObject({
      status: "success",
      data: "cached",
      updatedAt: null,
    });
  });
});

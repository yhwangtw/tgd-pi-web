// @vitest-environment jsdom

import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRequestState } from "@/lib/request-state";
import { useRequestResource } from "../useRequestResource";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useRequestResource", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    resetRequestState();
  });

  it("reuses fresh cached data when a panel closes and reopens", async () => {
    const fetcher = vi.fn(async () => ({ value: "cached" }));
    let observed!: ReturnType<typeof useRequestResource<{ value: string }>>;
    function Harness() {
      const state = useRequestResource("panel:cached", fetcher, { staleTimeMs: 60_000 });
      useEffect(() => { observed = state; }, [state]);
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    expect(observed.data).toEqual({ value: "cached" });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => root?.unmount());
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    expect(observed.data).toEqual({ value: "cached" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts the shared load when its last mounted panel unmounts", async () => {
    let aborted = false;
    function Harness() {
      useRequestResource("panel:abort", (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }));
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    await act(async () => root?.unmount());
    root = null;
    expect(aborted).toBe(true);
  });

  it("keeps the shared load alive across the StrictMode effect probe", async () => {
    const fetcher = vi.fn((signal: AbortSignal) => new Promise<{ value: string }>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ value: "strict-ready" }), 5);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }));
    let observed!: ReturnType<typeof useRequestResource<{ value: string }>>;
    function Harness() {
      const state = useRequestResource("panel:strict", fetcher);
      useEffect(() => { observed = state; }, [state]);
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<StrictMode><Harness /></StrictMode>));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(observed.data).toEqual({ value: "strict-ready" });
    expect(observed.status).toBe("success");
  });

  it("debounces query-style resources without delaying an explicit refresh", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => ({ value: "searched" }));
      let observed!: ReturnType<typeof useRequestResource<{ value: string }>>;
      function Harness() {
        const state = useRequestResource("search:debounced", fetcher, { debounceMs: 250 });
        useEffect(() => { observed = state; }, [state]);
        return null;
      }

      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root?.render(<Harness />));
      expect(fetcher).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTimeAsync(249));
      expect(fetcher).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(observed.data).toEqual({ value: "searched" });

      observed.invalidate(true);
      await act(async () => { await observed.refresh(); });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

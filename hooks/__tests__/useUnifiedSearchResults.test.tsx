// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@/lib/types";
import { resetRequestState } from "@/lib/request-state";
import { useUnifiedSearchResults } from "../useUnifiedSearchResults";

const list = vi.hoisted(() => ({
  snapshot: { allSessions: [] as SessionInfo[], loading: false, error: null },
  listeners: new Set<() => void>(),
}));
vi.mock("@/lib/session-list-store", () => ({
  getSessionListSnapshot: () => list.snapshot,
  getServerSessionListSnapshot: () => list.snapshot,
  subscribeSessionList: (listener: () => void) => {
    list.listeners.add(listener);
    return () => list.listeners.delete(listener);
  },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("live conversation search", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useUnifiedSearchResults>;
  let hits: Array<{ id: string; name: string }>;
  let fetchMock: ReturnType<typeof vi.fn>;
  function Harness() {
    const value = useUnifiedSearchResults(null, "audit", "sessions", false);
    useEffect(() => { current = value; }, [value]);
    return null;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    list.snapshot = { allSessions: [], loading: false, error: null };
    hits = [];
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ hits })));
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetRequestState();
    list.listeners.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function mount() {
    await act(async () => root.render(<Harness />));
    await act(async () => vi.advanceTimersByTimeAsync(250));
  }
  async function publish(name: string) {
    hits = [{ id: "new", name }];
    await act(async () => {
      list.snapshot = { ...list.snapshot, allSessions: [{ id: "new", name } as SessionInfo] };
      list.listeners.forEach(listener => listener());
    });
  }

  it("refreshes an unchanged query on creation and rename inside the cache freshness window", async () => {
    await mount();
    expect(current.sessionHits).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await publish("audit created");
    expect(current.sessionHits[0].name).toBe("audit created");
    await publish("audit renamed");
    expect(current.sessionHits[0].name).toBe("audit renamed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("forces a manual refresh even when the list itself has not changed", async () => {
    await mount();
    hits = [{ id: "new", name: "audit indexed later" }];
    await act(async () => { await current.refresh(); });
    expect(current.sessionHits[0].name).toBe("audit indexed later");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rechecks after an older in-flight search settles", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    await mount();
    expect(current.loading).toBe(true);
    await publish("audit created during search");
    await act(async () => { resolve(new Response(JSON.stringify({ hits: [] }))); });
    expect(current.sessionHits[0].name).toBe("audit created during search");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

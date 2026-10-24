// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFileWatch } from "../useFileWatch";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class FakeEventSource {
  static sources: FakeEventSource[] = [];
  listeners = new Map<string, (() => void)[]>();
  close = vi.fn();
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.sources.push(this); }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string) { this.listeners.get(type)?.forEach(listener => listener()); }
}
let root: Root;
let host: HTMLDivElement;
let state: ReturnType<typeof useFileWatch>;
let renders = 0;
function Harness({ path = "/project/a.ts", enabled = true }) {
  const next = useFileWatch(path, enabled);
  renders++;
  useLayoutEffect(() => { state = next; });
  return null;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("EventSource", FakeEventSource); FakeEventSource.sources = []; renders = 0;
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ nextHopProtocol: "h2" } as PerformanceNavigationTiming]);
  host = document.createElement("div"); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("coalesces100 rapid file events into one render/media reload notification", async () => {
  await act(async () => root.render(<Harness />));
  const source = FakeEventSource.sources[0];
  await act(async () => source.emit("connected"));
  expect(state.watching).toBe(true);
  const before = renders;
  for (let i = 0; i < 100; i++) await act(async () => source.emit("change"));
  expect(state.refreshTrigger).toBe(0);
  expect(renders).toBe(before);
  await act(async () => vi.advanceTimersByTime(100));
  expect(state.refreshTrigger).toBe(1);
  expect(renders).toBe(before + 1);
  await act(async () => source.emit("change"));
  await act(async () => vi.advanceTimersByTime(100));
  expect(state.refreshTrigger).toBe(2);
});

it("uses bounded metadata requests on HTTP/1, detects same-size replacements and skips unchanged content", async () => {
  vi.mocked(performance.getEntriesByType).mockReturnValue([{ nextHopProtocol: "http/1.1" } as PerformanceNavigationTiming]);
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ revision: "inode:1:10:100:100" }) });
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<Harness />));
  expect(FakeEventSource.sources).toHaveLength(0);
  expect(state).toEqual({ watching: true, refreshTrigger: 0 });
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(state.refreshTrigger).toBe(0);
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ revision: "inode:2:10:100:200" }) });
  await act(async () => vi.advanceTimersByTimeAsync(1_100));
  expect(state).toEqual({ watching: true, refreshTrigger: 1 });
  expect(fetcher.mock.calls.every(([, options]) => options.cache === "no-store")).toBe(true);
});

it("does not overlap slow metadata requests and aborts them when disabled", async () => {
  vi.mocked(performance.getEntriesByType).mockReturnValue([]);
  const fetcher = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(fetcher).toHaveBeenCalledOnce();
  const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
  await act(async () => root.render(<Harness enabled={false} />));
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(fetcher).toHaveBeenCalledOnce();
});

it("releases a hidden panel's stream, backfills on reopen and ignores late events", async () => {
  await act(async () => root.render(<Harness />));
  const first = FakeEventSource.sources[0];
  await act(async () => first.emit("connected"));
  await act(async () => root.render(<Harness enabled={false} />));
  expect(first.close).toHaveBeenCalledOnce();
  await act(async () => { first.emit("change"); vi.advanceTimersByTime(200); });
  expect(state).toEqual({ watching: false, refreshTrigger: 0 });
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTime(100));
  expect(state.refreshTrigger).toBe(1);
  expect(FakeEventSource.sources).toHaveLength(2);
});

it("stops background metadata work and reconciles edits when the document becomes visible", async () => {
  vi.mocked(performance.getEntriesByType).mockReturnValue([]);
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ revision: "1" }) });
  vi.stubGlobal("fetch", fetcher);
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
  await act(async () => root.render(<Harness />));
  await act(async () => { visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); });
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fetcher).toHaveBeenCalledOnce();
  await act(async () => { visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(state).toEqual({ watching: true, refreshTrigger: 1 });
});

it("delivers bounded updates during continuous writes and cancels stale path notifications", async () => {
  await act(async () => root.render(<Harness />));
  const old = FakeEventSource.sources[0];
  for (let i = 0; i < 10; i++) {
    await act(async () => old.emit("change"));
    await act(async () => vi.advanceTimersByTime(20));
  }
  expect(state.refreshTrigger).toBe(2);
  await act(async () => old.emit("change"));
  await act(async () => root.render(<Harness path="/project/b.ts" />));
  expect(old.close).toHaveBeenCalledOnce();
  await act(async () => { old.emit("connected"); old.emit("change"); vi.advanceTimersByTime(200); });
  expect(state).toEqual({ watching: false, refreshTrigger: 0 });
  const current = FakeEventSource.sources[1];
  await act(async () => { current.emit("connected"); current.emit("change"); vi.advanceTimersByTime(100); });
  expect(state).toEqual({ watching: true, refreshTrigger: 1 });
  await act(async () => current.emit("change"));
  await act(async () => root.unmount());
  root = createRoot(host);
  expect(vi.getTimerCount()).toBe(0);
  expect(current.close).toHaveBeenCalledOnce();
});

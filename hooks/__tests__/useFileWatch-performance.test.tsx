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
function Harness({ path = "/project/a.ts" }) {
  const next = useFileWatch(path);
  renders++;
  useLayoutEffect(() => { state = next; });
  return null;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("EventSource", FakeEventSource); FakeEventSource.sources = []; renders = 0;
  host = document.createElement("div"); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

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

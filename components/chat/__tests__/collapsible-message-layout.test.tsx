// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CollapsibleMessage } from "../CollapsibleMessage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("defers repeated resize measurements, expands normally and cancels queued work", async () => {
  let notify: ResizeObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { notify = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const frames = new Map<number, FrameRequestCallback>(); let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  const measure = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const toggle = vi.fn();
  try {
    await act(async () => root.render(<CollapsibleMessage collapsible expanded={false} onToggle={toggle}><p>Long history</p></CollapsibleMessage>));
    expect(host.querySelector<HTMLElement>("[style]")?.style.maxHeight).toBe("380px");
    measure.mockClear();
    for (let i = 0; i < 30; i++) notify!([], {} as ResizeObserver);
    expect(measure).not.toHaveBeenCalled(); expect(frames.size).toBe(1);
    await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); });
    expect(measure).toHaveBeenCalledTimes(1);
    await act(async () => host.querySelector("button")!.click()); expect(toggle).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<CollapsibleMessage collapsible expanded onToggle={toggle}><p>Long history</p></CollapsibleMessage>));
    expect(host.querySelector<HTMLElement>("p")?.parentElement?.style.maxHeight).toBe("");
    notify!([], {} as ResizeObserver); expect(frames.size).toBe(1);
    await act(async () => root.render(null)); expect(disconnect).toHaveBeenCalled(); expect(frames.size).toBe(0);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

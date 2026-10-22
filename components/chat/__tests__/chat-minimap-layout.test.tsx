// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatMinimap, useMessageRefs } from "../ChatMinimap";
import styles from "../ChatMinimap.module.css";
import type { UserMessage } from "@/lib/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const observers = new Set<Observer>();
class Observer {
  constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
  observe = vi.fn();
  disconnect = vi.fn(() => observers.delete(this));
  unobserve = vi.fn();
  fire() { this.callback([], this); }
}
let host: HTMLDivElement;
let scroll: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let messages: UserMessage[];
let rows: HTMLDivElement[];
let rowReads: ReturnType<typeof vi.fn<(index: number) => DOMRect>>;
let containerReads: ReturnType<typeof vi.fn<() => DOMRect>>;
let totalHeight: number;
let scrollContainer: { current: HTMLDivElement };
let messageRefs: { current: HTMLDivElement[] };
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, width: 800, left: 0, right: 800, x: 0, y: top, toJSON() {} });
async function flush() {
  await act(async () => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(0));
  });
}
async function render() {
  await act(async () => root.render(<ChatMinimap messages={messages} streamingMessage={null} scrollContainer={scrollContainer} messageRefs={messageRefs} />));
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  host = document.createElement("div"); scroll = document.createElement("div");
  document.body.append(scroll, host); root = createRoot(host);
  const content = document.createElement("div"); scroll.append(content);
  messages = Array.from({ length: 1000 }, (_, i) => ({ role: "user", content: `Question ${i}`, timestamp: i }));
  totalHeight = 120_000;
  Object.defineProperty(scroll, "scrollHeight", { get: () => totalHeight });
  Object.defineProperty(scroll, "clientHeight", { get: () => 600 });
  containerReads = vi.fn(() => rect(0, 600)); scroll.getBoundingClientRect = containerReads;
  rowReads = vi.fn((index: number) => rect(index * 120 - scroll.scrollTop, 120));
  rows = messages.map((_, i) => {
    const row = document.createElement("div"); content.append(row);
    row.getBoundingClientRect = () => rowReads(i); return row;
  });
  scrollContainer = { current: scroll }; messageRefs = { current: rows };
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); scroll.remove();
  frames.clear(); observers.clear(); vi.unstubAllGlobals();
});

it("scrolls a thousand-message history without remeasuring any message rows", async () => {
  await render(); await flush();
  expect(rowReads).toHaveBeenCalledTimes(1000);
  expect(containerReads).toHaveBeenCalledTimes(1);
  rowReads.mockClear(); containerReads.mockClear();
  await act(async () => {
    for (let i = 1; i <= 100; i++) { scroll.scrollTop = i * 60; scroll.dispatchEvent(new Event("scroll")); }
  });
  expect(frames.size).toBe(1); await flush();
  expect(rowReads).not.toHaveBeenCalled(); expect(containerReads).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLElement>(`.${styles.viewportIndicator}`)?.style.top).toBe("5%");
});

it("coalesces resize delivery and scroll into one geometry pass outside the observer", async () => {
  await render(); await flush(); rowReads.mockClear(); containerReads.mockClear();
  totalHeight *= 2;
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      observers.forEach(observer => observer.fire()); scroll.dispatchEvent(new Event("scroll"));
    }
  });
  expect(rowReads).not.toHaveBeenCalled(); expect(frames.size).toBe(1);
  await flush(); expect(rowReads).toHaveBeenCalledTimes(1000); expect(containerReads).toHaveBeenCalledTimes(1);
});

it("refreshes nodes for a same-length replacement and cancels pending work on unmount", async () => {
  await render(); await flush();
  messages = messages.map(message => ({ ...message, content: "Different branch" }));
  await render(); await flush();
  expect(host.querySelector("button")?.getAttribute("aria-label")).toContain("Different branch");
  observers.forEach(observer => observer.fire()); expect(frames.size).toBe(1);
  await act(async () => root.render(null));
  expect(frames.size).toBe(0); expect(observers.size).toBe(0);
});

it("previews only the keyboard-focused message in a thousand-message history", async () => {
  await render(); await flush();
  expect(host.querySelectorAll(`.${styles.tooltip}`)).toHaveLength(0);
  const buttons = host.querySelectorAll<HTMLButtonElement>("button");
  await act(async () => buttons[500].focus());
  expect(host.querySelectorAll(`.${styles.tooltip}`)).toHaveLength(1);
  expect(host.querySelector(`.${styles.tooltip}`)?.textContent).toBe("Question 500");
  await act(async () => buttons[501].focus());
  expect(host.querySelectorAll(`.${styles.tooltip}`)).toHaveLength(1);
  expect(host.querySelector(`.${styles.tooltip}`)?.textContent).toBe("Question 501");
  await act(async () => buttons[501].blur());
  expect(host.querySelectorAll(`.${styles.tooltip}`)).toHaveLength(0);
});

it("jumps to the preview nearest a pointer in overlapping hit areas while preserving keyboard targets", async () => {
  await render(); await flush();
  host.querySelector<HTMLElement>(`.${styles.container}`)!.getBoundingClientRect = () => rect(0, 600);
  rows.forEach(row => { row.scrollIntoView = vi.fn(); });
  const buttons = host.querySelectorAll<HTMLButtonElement>("button");
  await act(async () => buttons[900].dispatchEvent(new MouseEvent("click", { clientY: 300, detail: 1, bubbles: true })));
  expect(rows[500].scrollIntoView).toHaveBeenCalledOnce();
  expect(rows[900].scrollIntoView).not.toHaveBeenCalled();
  await act(async () => buttons[900].click());
  expect(rows[900].scrollIntoView).toHaveBeenCalledOnce();
});


it("keeps the message-ref array stable across token renders and resizes only on commits", async () => {
  let observed: ReturnType<typeof useMessageRefs>;
  function Probe({ count }: { count: number }) {
    const refs = useMessageRefs(count);
    useLayoutEffect(() => { observed = refs; });
    return null;
  }
  await act(async () => root.render(<Probe count={10_000} />));
  const first = observed!.current;
  first[100] = rows[0];
  for (let i = 0; i < 5; i++) await act(async () => root.render(<Probe count={10_000} />));
  expect(observed!.current).toBe(first);
  await act(async () => root.render(<Probe count={10_001} />));
  expect(observed!.current).toBe(first);
  expect(first[100]).toBe(rows[0]);
  expect(first[10_000]).toBeNull();
  await act(async () => root.render(<Probe count={50} />));
  expect(first).toHaveLength(50);
});

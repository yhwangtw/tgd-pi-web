// @vitest-environment jsdom
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTranscriptHistory } from "../use-transcript-history";
import {
  clearScrollPositions,
  loadTranscriptHistoryStart,
  saveScrollPosition,
  saveTranscriptHistoryStart,
} from "@/lib/scroll-memory";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const keys = Array.from({ length: 10_000 }, (_, index) => `entry-${index}`);
interface Props {
  entries?: readonly string[];
  sessionKey?: string;
  currentTurnStartIndex?: number;
  /** Sample real rows for logical-index tests; geometry tests mount the complete range. */
  renderedIndices?: readonly number[];
}
let current: ReturnType<typeof useTranscriptHistory>;
function Harness({ entries = keys, sessionKey = "large", currentTurnStartIndex, renderedIndices }: Props) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const history = useTranscriptHistory({ visibleKeys: entries, sessionKey, currentTurnStartIndex, scrollContainerRef, messageRefs });
  useLayoutEffect(() => { current = history; });
  const mounted = renderedIndices
    ? renderedIndices.filter(index => index >= history.startIndex).map(index => ({ key: entries[index], index }))
    : entries.slice(history.startIndex).map((key, offset) => ({ key, index: history.startIndex + offset }));
  return <div data-scroller="true" ref={scrollContainerRef}>
    {mounted.map(({ key, index }) => {
      return <div data-index={index} key={key} ref={element => { messageRefs.current[index] = element; }}>{key}</div>;
    })}
  </div>;
}

let root: Root;
let host: HTMLDivElement;
let rectCalls: number;
function scroller() { return host.firstElementChild as HTMLDivElement; }
function rows() { return scroller().querySelectorAll<HTMLElement>("[data-index]"); }
function row(index: number) { return scroller().querySelector<HTMLElement>(`[data-index="${index}"]`)!; }
function rect(top: number, height: number): DOMRect {
  return { x: 0, y: top, top, left: 0, right: 500, bottom: top + height, width: 500, height, toJSON() {} };
}

beforeEach(() => {
  vi.useFakeTimers(); clearScrollPositions(); rectCalls = 0;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    rectCalls++;
    if (this.dataset.scroller) return rect(100, 400);
    const container = this.parentElement as HTMLDivElement;
    const first = Number(container.firstElementChild?.getAttribute("data-index") ?? 0);
    return rect(100 + (Number(this.dataset.index) - first) * 20 - container.scrollTop, 20);
  });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  clearScrollPositions(); vi.restoreAllMocks(); vi.useRealTimers();
});

async function render(props: Props = {}) { await act(async () => root.render(<Harness {...props} />)); }
async function settlePrepend() { await act(async () => vi.advanceTimersByTime(40)); }

describe("progressive transcript history", () => {
  it("mounts only the most recent 200 rows when 10k messages arrive asynchronously", async () => {
    await render({ entries: [] });
    await render();
    expect(current.startIndex).toBe(9800);
    expect(rows()).toHaveLength(200);
    expect(rows()[0].textContent).toBe("entry-9800");
    expect(rows()[199].textContent).toBe("entry-9999");
    expect(rectCalls).toBe(0);
  });

  it("keeps the active turn complete and never advances the start on append", async () => {
    await render({ currentTurnStartIndex: 9750 });
    expect(rows()).toHaveLength(250);
    const appended = [...keys, ...Array.from({ length: 100 }, (_, i) => `new-${i}`)];
    await render({ entries: appended, currentTurnStartIndex: 10_000 });
    expect(current.startIndex).toBe(9750);
    expect(rows()).toHaveLength(350);
  });

  it("prepends 200 real rows while preserving the first visible existing row", async () => {
    await render();
    const container = scroller();
    container.style.overflowAnchor = "auto";
    container.scrollTop = 200;
    const before = row(9810).getBoundingClientRect().top;
    await act(async () => { expect(current.loadPrevious()).toBe(true); expect(current.isPrependingRef.current).toBe(true); });
    expect(current.startIndex).toBe(9600);
    expect(rows()).toHaveLength(400);
    expect(container.scrollTop).toBe(4200);
    expect(row(9810).getBoundingClientRect().top).toBe(before);
    expect(container.style.overflowAnchor).toBe("none");
    expect(current.isPrependingRef.current).toBe(true);
    // Scans only the mounted prefix to the current viewport, not all 10k refs.
    expect(rectCalls).toBeLessThan(25);
    await settlePrepend();
    expect(current.isPrependingRef.current).toBe(false);
    expect(container.style.overflowAnchor).toBe("auto");
  });

  it("coalesces repeated load clicks and only expands a pending explicit reveal", async () => {
    await render();
    await act(async () => {
      expect(current.loadPrevious()).toBe(true);
      expect(current.loadPrevious()).toBe(false);
      expect(current.reveal(9500)).toBe(true);
      expect(current.reveal(9700)).toBe(false);
    });
    expect(current.startIndex).toBe(9500);
    expect(rows()).toHaveLength(500);
    await settlePrepend();
  });

  it("finishes anchoring when a newly expanded active turn extends beyond a pending page", async () => {
    await render();
    scroller().scrollTop = 200;
    const top = row(9810).getBoundingClientRect().top;
    await act(async () => {
      current.loadPrevious();
      root.render(<Harness currentTurnStartIndex={9500} />);
    });
    expect(current.startIndex).toBe(9500);
    expect(row(9810).getBoundingClientRect().top).toBe(top);
    await settlePrepend();
    expect(current.isPrependingRef.current).toBe(false);
  });

  it("reveals old logical search/bookmark indices without changing their identity", async () => {
    // Exercise all 10k logical keys without turning an index test into a 9,760-node
    // React/jsdom prepend benchmark. Paging and anchoring above use complete rows.
    await render({ renderedIndices: [0, 39, 40, 41, 9799, 9800, 9999] });
    expect(current.startIndex).toBe(9800);
    expect(rows()).toHaveLength(2);
    const retainedTail = row(9999);
    await act(async () => { expect(current.reveal(40)).toBe(true); });
    expect(current.startIndex).toBe(40);
    expect(row(39)).toBeNull();
    expect(row(40).textContent).toBe("entry-40");
    expect(row(41).textContent).toBe("entry-41");
    expect(row(9999)).toBe(retainedTail);
    expect(row(9999).textContent).toBe("entry-9999");
    expect(rows()).toHaveLength(5);
    await settlePrepend();
    await act(async () => {
      expect(current.reveal(9999)).toBe(false);
      expect(current.reveal(NaN)).toBe(false);
      expect(current.reveal(-1)).toBe(true);
    });
    expect(current.startIndex).toBe(0);
    expect(row(0).textContent).toBe("entry-0");
    expect(row(39).textContent).toBe("entry-39");
    expect(row(9999)).toBe(retainedTail);
    expect(row(9999).textContent).toBe("entry-9999");
    expect(rows()).toHaveLength(7);
    expect(current.hasPrevious).toBe(false);
    await settlePrepend();
    expect(current.loadPrevious()).toBe(false);
  });

  it("remembers the first mounted entry across remounts and appended messages", async () => {
    await render();
    await act(async () => current.loadPrevious());
    await settlePrepend();
    expect(loadTranscriptHistoryStart("large")).toBe("entry-9600");
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ entries: [...keys, "latest"] });
    expect(current.startIndex).toBe(9600);
    expect(rows()).toHaveLength(401);
  });

  it("preserves old full-history pixel restoration and uses bounded DOM for old tail records", async () => {
    saveScrollPosition("legacy", 600, 200);
    await render({ sessionKey: "legacy" });
    expect(current.startIndex).toBe(0);
    expect(rows()).toHaveLength(10_000);
    saveScrollPosition("tail", 600, 0);
    await render({ sessionKey: "tail" });
    expect(current.startIndex).toBe(9800);
    expect(rows()).toHaveLength(200);
  });

  it("resolves tab-local range records without requiring an in-memory map entry", async () => {
    sessionStorage.setItem("pi-transcript-history-starts", JSON.stringify([["large", "entry-9400"], ["invalid", {}]]));
    await render();
    expect(current.startIndex).toBe(9400);
    expect(rows()).toHaveLength(600);
    expect(loadTranscriptHistoryStart("invalid")).toBeUndefined();
  });

  it("resets a replaced branch and safely ignores a missing stored boundary", async () => {
    await render();
    const branch = keys.map(key => `other-${key}`);
    await render({ entries: branch });
    expect(current.startIndex).toBe(9800);
    expect(rows()[0].textContent).toBe("other-entry-9800");
    saveTranscriptHistoryStart("missing", "deleted-entry");
    await render({ sessionKey: "missing" });
    expect(current.startIndex).toBe(9800);
  });

  it("cancels pending anchor work on a session switch or unmount", async () => {
    const requestFrame = vi.spyOn(globalThis, "requestAnimationFrame");
    const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame");
    await render();
    const container = scroller(); container.style.overflowAnchor = "auto";
    await act(async () => current.loadPrevious());
    const pendingFrame = requestFrame.mock.results.at(-1)?.value;
    expect(current.isPrependingRef.current).toBe(true);
    await render({ sessionKey: "other" });
    expect(current.startIndex).toBe(9800);
    expect(current.isPrependingRef.current).toBe(false);
    expect(container.style.overflowAnchor).toBe("auto");
    expect(cancelFrame).toHaveBeenCalledWith(pendingFrame);
    await act(async () => current.loadPrevious());
    const unmountFrame = requestFrame.mock.results.at(-1)?.value;
    const pendingRef = current.isPrependingRef;
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(cancelFrame).toHaveBeenCalledWith(unmountFrame);
    expect(pendingRef.current).toBe(false);
    expect(container.style.overflowAnchor).toBe("auto");
  });

  it("works without a persisted session and clears both pixel and range memory together", async () => {
    await render({ sessionKey: "" });
    expect(current.startIndex).toBe(9800);
    await act(async () => current.loadPrevious());
    await settlePrepend();
    expect(current.startIndex).toBe(9600);
    saveTranscriptHistoryStart("clear", "entry-9600");
    clearScrollPositions();
    expect(loadTranscriptHistoryStart("clear")).toBeUndefined();
    expect(sessionStorage.getItem("pi-transcript-history-starts")).toBeNull();
  });
});

// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isTranscriptTailOutOfView,
  preservedRunSpacerHeight,
  useTranscriptScroll,
} from "../use-transcript-scroll";
import { resetScrollFollowModeCache } from "@/lib/prefs";
import { clearScrollPositions, saveScrollPosition } from "@/lib/scroll-memory";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface HarnessProps {
  messagesLength: number;
  running: boolean;
  runningRef: React.RefObject<boolean>;
  onRefs?: (refs: ReturnType<typeof useTranscriptScroll>) => void;
  memoryKey?: string;
  streamingOutput?: boolean;
}

function Harness({ messagesLength, running, runningRef, onRefs, memoryKey, streamingOutput }: HarnessProps) {
  const refs = useTranscriptScroll(messagesLength, running, runningRef, memoryKey, streamingOutput);
  useEffect(() => onRefs?.(refs), [onRefs, refs]);
  return (
    <div ref={refs.scrollContainerRef}>
      <div ref={refs.lastUserMsgRef}>Question</div>
      <div ref={refs.messagesEndRef} />
    </div>
  );
}

describe("useTranscriptScroll", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let scrollTo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    clearScrollPositions();
    resetScrollFollowModeCache();
    scrollIntoView = vi.fn();
    scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("cancels delayed position restoration as soon as the reader scrolls", async () => {
    vi.useFakeTimers();
    saveScrollPosition("reading", 480, 200);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root?.render(<Harness memoryKey="reading" messagesLength={10} running={false} runningRef={{ current: false }} />));
    const scroller = container.firstElementChild as HTMLElement;
    expect(scroller.scrollTop).toBe(480);
    scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
    scroller.scrollTop = 380;
    await act(async () => vi.advanceTimersByTime(100));
    expect(scroller.scrollTop).toBe(380);
  });

  async function renderRun(mode: "smart" | "always" | "preserve") {
    localStorage.setItem("pi-scroll-follow-mode", mode);
    resetScrollFollowModeCache();
    const runningRef = { current: true } as React.RefObject<boolean>;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness messagesLength={1} running runningRef={runningRef} />);
    });
    scrollIntoView.mockClear();

    runningRef.current = false;
    await act(async () => {
      root?.render(<Harness messagesLength={2} running={false} runningRef={runningRef} />);
    });
  }

  it("does not pull an anchored reader to the bottom when a run ends", async () => {
    await renderRun("smart");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("preserves the completed response position in preserve mode", async () => {
    await renderRun("preserve");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("still follows the completed response when always-follow is enabled", async () => {
    await renderRun("always");
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
  });

  it("follows immediately when the reader requests reduced motion", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    await renderRun("always");
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "end" });
  });

  it("keeps only the filler required to prevent end-of-run scroll clamping", () => {
    expect(preservedRunSpacerHeight(1_000, 800, 2_080, 800)).toBe(520);
    expect(preservedRunSpacerHeight(400, 800, 2_080, 800)).toBe(0);
  });

  it("shows Latest from the real message tail instead of the run spacer", () => {
    expect(isTranscriptTailOutOfView(480, 500)).toBe(false);
    expect(isTranscriptTailOutOfView(596, 500)).toBe(false);
    expect(isTranscriptTailOutOfView(597, 500)).toBe(true);
  });

  async function sendWithGeometry({
    mode = "smart", height = 600, messageHeight = 60, messageTop = 520, scrollTop = 1_000,
  }: {
    mode?: "smart" | "always" | "preserve";
    height?: number; messageHeight?: number; messageTop?: number; scrollTop?: number;
  } = {}) {
    localStorage.setItem("pi-scroll-follow-mode", mode);
    resetScrollFollowModeCache();
    const runningRef = { current: true } as React.RefObject<boolean>;
    let refs: ReturnType<typeof useTranscriptScroll> | null = null;
    const capture = (next: ReturnType<typeof useTranscriptScroll>) => { refs = next; };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<Harness messagesLength={0} running runningRef={runningRef} onRefs={capture} />);
    });
    const scroller = refs!.scrollContainerRef.current!;
    const message = refs!.lastUserMsgRef.current!;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: height });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 80, height, bottom: 80 + height } as DOMRect);
    vi.spyOn(message, "getBoundingClientRect").mockReturnValue({ top: 80 + messageTop, height: messageHeight, bottom: 80 + messageTop + messageHeight } as DOMRect);
    scroller.scrollTop = scrollTop;
    refs!.pendingScrollToUserRef.current = true;
    await act(async () => {
      root?.render(<Harness messagesLength={1} running runningRef={runningRef} onRefs={capture} />);
    });
    return { refs: refs!, scroller, message };
  }

  it.each(["smart", "always"] as const)("%s anchors a short sent message at the upper quarter immediately", async (mode) => {
    await sendWithGeometry({ mode });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1_370, behavior: "auto" });
  });

  it("gives a tall sent message room to stay fully visible", async () => {
    await sendWithGeometry({ messageHeight: 550 });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1_486, behavior: "auto" });
  });

  it.each(["smart", "preserve"] as const)("%s reveals the beginning of an oversized prompt", async (mode) => {
    await sendWithGeometry({ mode, messageHeight: 900, messageTop: 620 });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1_604, behavior: "auto" });
  });

  it("uses the actual short viewport rather than a fixed desktop offset", async () => {
    await sendWithGeometry({ height: 200, messageHeight: 40, messageTop: 170 });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1_120, behavior: "auto" });
  });

  it("does not scroll above the beginning of a new conversation", async () => {
    await sendWithGeometry({ scrollTop: 0, messageTop: 16 });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("preserve leaves a fully visible prompt where it is", async () => {
    await sendWithGeometry({ mode: "preserve", messageTop: 420 });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("preserve only reveals the bottom of a partially visible short prompt", async () => {
    await sendWithGeometry({ mode: "preserve", messageTop: 570 });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1_046, behavior: "auto" });
  });

  it("preserve reveals a prompt above the viewport with the minimum offset", async () => {
    await sendWithGeometry({ mode: "preserve", messageTop: -60 });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 924, behavior: "auto" });
  });

  it("preserve does not reposition an oversized prompt whose beginning is already visible", async () => {
    await sendWithGeometry({ mode: "preserve", messageHeight: 900, messageTop: 100 });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("reconciles the anchor once when previous history collapses after send", async () => {
    let settle: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { settle = callback; return 1; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { message } = await sendWithGeometry();
    vi.mocked(message.getBoundingClientRect).mockReturnValue({ top: 80 + 260, height: 60, bottom: 80 + 320 } as DOMRect);
    scrollTo.mockClear();
    await act(async () => { settle!(0); });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1_110, behavior: "auto" });
  });

  it.each(["reader", "reply"] as const)("repairs a late viewport resize, then yields to %s", async (stop) => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let resize!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = () => callback([], this as unknown as ResizeObserver); }
      observe() {}
      disconnect = disconnect;
    });
    const { refs, scroller, message } = await sendWithGeometry();
    let height = 600;
    scroller.scrollTop = 1370;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => height });
    vi.mocked(scroller.getBoundingClientRect).mockImplementation(() => ({ top: 80, height, bottom: 80 + height }) as DOMRect);
    vi.mocked(message.getBoundingClientRect).mockImplementation(() => ({ top: 80 + 1520 - scroller.scrollTop, height: 60 }) as DOMRect);
    scrollTo.mockImplementation(({ top }: ScrollToOptions) => { scroller.scrollTop = top!; });
    await act(async () => { for (let i = 0; i < 4 && frames.length; i++) frames.shift()!(0); });
    expect(refs.sentMessageScrollRef.current.settling).toBe(false);
    height = 573; // The activity dock appears after the initial frame pass.
    await act(async () => resize());
    expect(message.getBoundingClientRect().top - 80).toBeCloseTo(height / 4);
    if (stop === "reader") scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
    else await act(async () => root?.render(<Harness messagesLength={2} running runningRef={{ current: true }} streamingOutput />));
    expect(disconnect).toHaveBeenCalled();
    scrollTo.mockClear();
    height = 500;
    await act(async () => resize());
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it.each(["wheel", "touchstart", "pointerdown", "keydown"])("cancels send settling on reader %s input", async (event) => {
    let settle: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { settle = callback; return 1; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { scroller } = await sendWithGeometry();
    scroller.dispatchEvent(new Event(event));
    scrollTo.mockClear();
    await act(async () => { settle!(0); });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it.each(["streaming", "committed"])("settling still follows a fast %s reply that has outgrown the viewport", async (phase) => {
    let settle: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { settle = callback; return 1; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { refs } = await sendWithGeometry();
    vi.spyOn(refs.messagesEndRef.current!, "getBoundingClientRect").mockReturnValue({ top: 1_200 } as DOMRect);
    await act(async () => {
      root?.render(<Harness messagesLength={phase === "committed" ? 2 : 1} running runningRef={{ current: true }} streamingOutput={phase === "streaming"} />);
    });
    scrollIntoView.mockClear();
    await act(async () => { settle!(0); });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "end" });
  });

  it("consumes the send anchor only once while the reply starts", async () => {
    const { refs } = await sendWithGeometry();
    expect(refs.pendingScrollToUserRef.current).toBe(false);
    scrollTo.mockClear();
    await act(async () => {
      root?.render(<Harness messagesLength={2} running runningRef={{ current: true }} />);
    });
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

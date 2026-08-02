// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preservedRunSpacerHeight, useTranscriptScroll } from "../use-transcript-scroll";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface HarnessProps {
  messagesLength: number;
  running: boolean;
  runningRef: React.RefObject<boolean>;
  onRefs?: (refs: ReturnType<typeof useTranscriptScroll>) => void;
}

function Harness({ messagesLength, running, runningRef, onRefs }: HarnessProps) {
  const refs = useTranscriptScroll(messagesLength, running, runningRef);
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
  });

  async function renderRun(alwaysFollow: boolean) {
    if (alwaysFollow) localStorage.setItem("pi-follow-stream", "1");
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
    await renderRun(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("still follows the completed response when always-follow is enabled", async () => {
    await renderRun(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
  });

  it("keeps only the filler required to prevent end-of-run scroll clamping", () => {
    expect(preservedRunSpacerHeight(1_000, 800, 2_080, 800)).toBe(520);
    expect(preservedRunSpacerHeight(400, 800, 2_080, 800)).toBe(0);
  });

  it("anchors a sent message immediately so a fast reply cannot outrun it", async () => {
    const runningRef = { current: true } as React.RefObject<boolean>;
    let refs: ReturnType<typeof useTranscriptScroll> | null = null;
    const capture = (next: ReturnType<typeof useTranscriptScroll>) => { refs = next; };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness messagesLength={0} running runningRef={runningRef} onRefs={capture} />);
    });
    refs!.pendingScrollToUserRef.current = true;
    await act(async () => {
      root?.render(<Harness messagesLength={1} running runningRef={runningRef} onRefs={capture} />);
    });

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@/lib/types";
import { createStreamUpdateScheduler, hasStreamMessageContent, streamMessageSize } from "../stream-update-scheduler";

describe("adaptive stream update scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const message = (content: unknown) => ({ role: "assistant", content }) as AgentMessage;
  function fixture(options: { hidden?: () => boolean; current?: (value: string) => boolean; now?: () => number } = {}) {
    const publish = vi.fn();
    const hasContent = vi.fn((value: string) => value.length > 0);
    const size = vi.fn((value: string) => value.length);
    const scheduler = createStreamUpdateScheduler({ publish, hasContent, size, isHidden: options.hidden, isCurrent: options.current, now: options.now });
    return { scheduler, publish, hasContent, size };
  }

  it("publishes first real content synchronously, then coalesces the latest snapshot at 16 ms", () => {
    const { scheduler, publish, hasContent, size } = fixture();
    scheduler.start("");
    scheduler.push("");
    scheduler.push("a");
    expect(publish.mock.calls.map(([value]) => value)).toEqual(["", "a"]);
    for (let i = 1; i <= 100; i++) scheduler.push("a".repeat(i + 1));
    expect(hasContent).toHaveBeenCalledTimes(3); // start + empty update + first content only
    expect(size).toHaveBeenCalledTimes(2); // inspect lengths only when publishing
    vi.advanceTimersByTime(15);
    expect(publish).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenLastCalledWith("a".repeat(101));
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("does not add a timer when the next chunk arrives after the frame budget", () => {
    const { scheduler, publish } = fixture();
    scheduler.push("a");
    vi.advanceTimersByTime(100);
    scheduler.push("ab");
    expect(publish).toHaveBeenLastCalledWith("ab");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[24_000, 33], [120_000, 80]])("backs off for a %i-character message to %i ms", (length, delay) => {
    const { scheduler, publish } = fixture();
    scheduler.push("a".repeat(length));
    scheduler.push("a".repeat(length + 1));
    vi.advanceTimersByTime(delay - 1);
    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("backs off when event-loop delivery is late and recovers after a timely frame", () => {
    let now = 0;
    const { scheduler, publish } = fixture({ now: () => now });
    scheduler.push("a");
    scheduler.push("ab");
    now = 60;
    vi.advanceTimersByTime(16); // 44 ms later than its deadline
    scheduler.push("abc");
    now = 139;
    vi.advanceTimersByTime(79);
    expect(publish).toHaveBeenCalledTimes(2);
    now = 140;
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenLastCalledWith("abc");
    scheduler.push("abcd");
    now = 156;
    vi.advanceTimersByTime(16);
    expect(publish).toHaveBeenLastCalledWith("abcd");
  });

  it("flushes pending progress once and cancels all work before a terminal/new message", () => {
    const { scheduler, publish } = fixture();
    scheduler.push("a"); scheduler.push("ab"); scheduler.flush();
    expect(publish).toHaveBeenLastCalledWith("ab");
    scheduler.push("abc"); scheduler.cancel();
    vi.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(2);
    scheduler.start(""); scheduler.push("new first");
    expect(publish).toHaveBeenLastCalledWith("new first");
    vi.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(4);
  });

  it("never publishes a queued snapshot after its session is no longer current", () => {
    let current = true;
    const { scheduler, publish } = fixture({ current: () => current });
    scheduler.push("a"); scheduler.push("old pending"); current = false;
    vi.advanceTimersByTime(100);
    scheduler.push("late old chunk"); scheduler.flush();
    expect(publish.mock.calls.map(([value]) => value)).toEqual(["a"]);
  });

  it("retains the latest background progress with timers and can immediately flush on visibility", () => {
    const { scheduler, publish } = fixture({ hidden: () => true });
    scheduler.push("a"); scheduler.push("ab"); scheduler.push("abc");
    vi.advanceTimersByTime(79);
    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenLastCalledWith("abc");
    scheduler.push("abcd"); scheduler.flush();
    expect(publish).toHaveBeenLastCalledWith("abcd");
    vi.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ type: "text", text: "first" }],
    [{ type: "thinking", thinking: "reasoning" }],
    [{ type: "toolCall", name: "read", id: "call-1", arguments: {} }],
    [{ type: "image", source: { type: "url", url: "fixture" } }],
  ])("recognizes visible text, thinking, tools and images as first content: %j", block => {
    const publish = vi.fn();
    const scheduler = createStreamUpdateScheduler({ publish, hasContent: hasStreamMessageContent, size: streamMessageSize });
    scheduler.start(message([]));
    scheduler.push(message([block]));
    expect(publish).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses string lengths for content detection and cost rather than serializing tools or scanning characters", () => {
    expect(hasStreamMessageContent(message([{ type: "text", text: "" }, { type: "thinking", thinking: "" }]))).toBe(false);
    expect(streamMessageSize(message([{ type: "text", text: "a".repeat(100_000) }, { type: "thinking", thinking: "b".repeat(20_000) }]))).toBe(120_000);
    const tool = { type: "toolCall", name: "read", arguments: { toJSON() { throw new Error("must not stringify"); } } };
    expect(hasStreamMessageContent(message([tool]))).toBe(true);
    expect(streamMessageSize(message([tool]))).toBe(256);
  });
});

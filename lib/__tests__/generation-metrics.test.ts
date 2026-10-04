import { describe, expect, it } from "vitest";
import { estimateTextTokens, GenerationMetricsTracker, TextRateWindow } from "../generation-metrics";
import type { AssistantMessage } from "../types";

const message = (text: string): AssistantMessage => ({ role: "assistant", timestamp: 123, provider: "test", model: "test", content: [{ type: "text", text }] });
function generate(tracker: GenerationMetricsTracker, end = message("a".repeat(80))) {
  tracker.record("session", { type: "message_start", message: message("") }, 0);
  tracker.record("session", { type: "message_update", message: message("aaaa") }, 1000);
  tracker.record("session", { type: "message_update", message: message("aaaaaaaa") }, 1500);
  tracker.record("session", { type: "message_end", message: end }, 2000);
}
describe("generation metrics", () => {
  it("restores real measurements after reload and keeps sessions and edited answers separate", () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
    const tracker = new GenerationMetricsTracker(storage);
    tracker.record("session", { type: "session_snapshot" }, 0);
    generate(tracker);
    const restored = new GenerationMetricsTracker(storage);
    const end = message("a".repeat(80));
    expect(restored.get("session", end)).toEqual({ tokens: 20, seconds: 2, estimated: true });
    expect(restored.get("session", end)).toBe(restored.get("session", end));
    expect(restored.get("another", end)).toBeUndefined();
    expect(restored.get("session", message("edited answer"))).toBeUndefined();
    expect([...memory.values()].join()).not.toContain("a".repeat(80));
  });
  it("tolerates unavailable storage and rejects malformed records", () => {
    const storage = { getItem: () => "not json", setItem: () => { throw new Error("QuotaExceeded"); } };
    const tracker = new GenerationMetricsTracker(storage);
    tracker.record("session", { type: "session_snapshot" }, 0);
    expect(() => generate(tracker)).not.toThrow();
    expect(tracker.get("session", message("a".repeat(80)))?.tokens).toBe(20);
    expect(new GenerationMetricsTracker(storage).get("session", message("a".repeat(80)))).toBeUndefined();
  });
  it("uses provider output counts and preserves measured timing across message reloads", () => {
    const tracker = new GenerationMetricsTracker();
    tracker.record("session", { type: "session_snapshot" }, 0);
    const end = { ...message("answer"), usage: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    generate(tracker, end);
    expect(tracker.get("session", structuredClone(end))).toEqual({ tokens: 100, seconds: 2, estimated: false });
    tracker.record("session", { type: "session_snapshot" }, 3000);
    expect(tracker.get("session", end)?.tokens).toBe(100);
    expect(tracker.get("other", end)).toBeUndefined();
  });
  it("labels a text-only estimate when provider usage is absent", () => {
    const tracker = new GenerationMetricsTracker();
    tracker.record("session", { type: "session_snapshot" }, 0);
    generate(tracker);
    expect(tracker.get("session", message("a".repeat(80)))).toEqual({ tokens: 20, seconds: 2, estimated: true });
    expect(estimateTextTokens("中文aaaa")).toBe(3);
  });
  it("never times replayed, partial, tool-only or aborted responses", () => {
    const tracker = new GenerationMetricsTracker();
    tracker.record("session", { type: "connected" }, 0);
    generate(tracker);
    expect(tracker.get("session", message("answer"))).toBeUndefined();
    tracker.record("session", { type: "session_snapshot" }, 0);
    tracker.record("session", { type: "message_end", message: message("answer") }, 2000);
    expect(tracker.get("session", message("answer"))).toBeUndefined();
    generate(tracker, { ...message("answer"), stopReason: "aborted" });
    expect(tracker.get("session", message("answer"))).toBeUndefined();
    generate(tracker, { ...message("answer"), content: [{ type: "toolCall", toolCallId: "1", toolName: "bash", input: { cmd: "lots of arguments" } }] });
    expect(tracker.get("session", message("answer"))).toBeUndefined();
  });
  it("drops an in-progress measurement on reconnect", () => {
    const tracker = new GenerationMetricsTracker();
    tracker.record("session", { type: "session_snapshot" }, 0);
    tracker.record("session", { type: "message_start", message: message("") }, 0);
    tracker.record("session", { type: "connected" }, 500);
    tracker.record("session", { type: "session_snapshot" }, 600);
    tracker.record("session", { type: "message_end", message: message("answer") }, 2000);
    expect(tracker.get("session", message("answer"))).toBeUndefined();
  });
});
describe("rolling live speed", () => {
  it("counts only new text, smooths it, and hides stale throughput", () => {
    const window = new TextRateWindow();
    expect(window.sample(1000, 0)).toBeNull();
    expect(window.sample(1010, 500)).toBeNull();
    expect(window.sample(1020, 1000)).toBe(20);
    expect(window.sample(1020, 1500)).toBeCloseTo(13.33, 1);
    expect(window.sample(1020, 3000)).toBeNull();
    expect(window.sample(0, 3500)).toBeNull();
  });
});

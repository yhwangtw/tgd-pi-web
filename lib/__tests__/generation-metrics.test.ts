import { describe, expect, it } from "vitest";
import { estimateTextTokens, estimateStreamTokens, GenerationMetricsTracker, TextRateWindow, generationMessageKey, validGenerationMetrics } from "../generation-metrics";
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
describe("received generation content", () => {
  it("counts received text, thinking and generated arguments without signatures or hidden output", () => {
    const sample = { ...message("answer"), content: [
      { type: "text" as const, text: "a".repeat(40) },
      { type: "thinking" as const, thinking: "b".repeat(80), thinkingSignature: "private".repeat(1000) },
      { type: "toolCall" as const, toolCallId: "1", toolName: "bash", input: { command: "echo test" } },
    ] };
    expect(estimateStreamTokens(sample)).toBe(30 + estimateTextTokens(JSON.stringify({ command: "echo test" })));
    expect(estimateStreamTokens(message(""))).toBe(0);
    const hidden = { type: "thinking" as const, thinking: "", thinkingSignature: "hidden" };
    expect(estimateStreamTokens({ ...message(""), content: [hidden] })).toBe(0);
    expect(estimateStreamTokens({ ...message(""), content: [{ type: "toolCall", toolCallId: "1", toolName: "bash", input: {} }] })).toBe(0);
  });
});

describe("rolling live speed", () => {
  it("measures short streams without requiring a full second, but not an instantaneous burst", () => {
    const window = new TextRateWindow();
    expect(window.sample(10, 0)).toBeNull();
    expect(window.sample(12, 10)).toBeNull();
    expect(window.sample(15, 250)).toBe(20);
    expect(window.sample(15, 2250)).toBeNull();
  });
  it("counts only new text, smooths it, and hides stale throughput", () => {
    const window = new TextRateWindow();
    expect(window.sample(1000, 0)).toBeNull();
    expect(window.sample(1010, 500)).toBe(20);
    expect(window.sample(1020, 1000)).toBe(20);
    expect(window.sample(1020, 1500)).toBeCloseTo(13.33, 1);
    expect(window.sample(1020, 3000)).toBeNull();
    expect(window.sample(0, 3500)).toBeNull();
  });
});


describe("authoritative server measurements", () => {
  const metrics = { tokens: 100, seconds: 0.8, estimated: false, source: "server" as const, firstContentSeconds: 0.6 };
  it("restores buffered replies without browser timing and isolates sessions and edits", () => {
    const tracker = new GenerationMetricsTracker();
    const answer = message("buffered answer");
    const key = generationMessageKey(answer)!;
    tracker.restore("one", { [key]: metrics });
    expect(tracker.get("one", answer)).toEqual(metrics);
    expect(tracker.get("two", answer)).toBeUndefined();
    expect(tracker.get("one", message("edited"))).toBeUndefined();
    tracker.restore("two", {});
    expect(tracker.get("two", answer)).toBeUndefined();
    tracker.restore("one", { [key]: metrics });
    expect(tracker.get("one", structuredClone(answer))).toEqual(metrics);
  });
  it("accepts server terminal frames during replay but never times replay locally", () => {
    const tracker = new GenerationMetricsTracker();
    const answer = message("buffered answer");
    tracker.record("one", { type: "connected" }, 100);
    tracker.record("one", { type: "message_end", message: answer, generationMetrics: metrics }, 101);
    expect(tracker.get("one", answer)).toEqual(metrics);
    tracker.record("two", { type: "message_end", message: answer }, 102);
    expect(tracker.get("two", answer)).toBeUndefined();
  });
  it("rejects corrupt, unknown or browser-origin authoritative records", () => {
    const tracker = new GenerationMetricsTracker();
    const answer = message("answer"); const key = generationMessageKey(answer)!;
    for (const invalid of [{ ...metrics, seconds: 0 }, { ...metrics, tokens: Infinity },
      { ...metrics, firstContentSeconds: 1 }, { ...metrics, source: "browser" }, { ...metrics, estimated: "false" }]) {
      tracker.restore("one", { [key]: invalid });
      expect(tracker.get("one", answer)).toBeUndefined();
    }
    expect(validGenerationMetrics({ ...metrics, seconds: Number.MIN_VALUE })).toBe(false);
  });
  it("matches SDK and normalized tool keys while invalidating same-object edits", () => {
    const raw = { ...message(""), content: [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "/tmp/a" } }] } as unknown as AssistantMessage;
    const normalized = { ...message(""), content: [{ type: "toolCall", toolCallId: "call1", toolName: "read", input: { path: "/tmp/a" } }] } as AssistantMessage;
    expect(generationMessageKey(raw)).toBe(generationMessageKey(normalized));
    const original = generationMessageKey(normalized);
    (normalized.content[0] as { input: object }).input = { path: "/tmp/b" };
    expect(generationMessageKey(normalized)).not.toBe(original);
    const thinking = { ...message("answer"), content: [{ type: "thinking", thinking: "one" }] } as AssistantMessage;
    const key = generationMessageKey(thinking);
    thinking.content = [{ type: "thinking", thinking: "two" }];
    expect(generationMessageKey(thinking)).not.toBe(key);
  });
  it("does not round a nonempty one-character reply down to zero tokens", () => {
    const tracker = new GenerationMetricsTracker();
    tracker.record("one", { type: "session_snapshot" }, 0);
    tracker.record("one", { type: "message_start", message: message("") }, 0);
    tracker.record("one", { type: "message_end", message: message("A") }, 100);
    expect(tracker.get("one", message("A"))).toMatchObject({ tokens: 1, seconds: 0.1, estimated: true });
  });
  it.each([800, 5000])("retains a fully observed single-chunk reply lasting %s ms", duration => {
    const tracker = new GenerationMetricsTracker();
    tracker.record("one", { type: "session_snapshot" }, 0);
    tracker.record("one", { type: "message_start", message: message("") }, 10);
    const answer = message("a".repeat(80));
    tracker.record("one", { type: "message_update", message: answer }, duration);
    tracker.record("one", { type: "message_end", message: answer }, duration + 10);
    expect(tracker.get("one", answer)).toEqual({ tokens: 20, seconds: duration / 1000, estimated: true });
  });
});

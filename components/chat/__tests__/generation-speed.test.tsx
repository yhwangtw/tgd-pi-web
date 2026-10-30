// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AssistantMessage } from "@/lib/types";
import { CompletedSpeed, StreamingSpeed } from "../GenerationSpeed";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseMessage: AssistantMessage = {
  role: "assistant",
  model: "test-model",
  provider: "test-provider",
  content: [],
};

describe("generation speed scope and help", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    setLocale("en");
    vi.useRealTimers();
  });

  async function render(node: ReactNode, locale: "en" | "zh" = "en") {
    setLocale(locale);
    if (!container) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => root!.render(node));
  }

  function speed(testId: "streaming-speed" | "completed-speed"): HTMLElement {
    return container!.querySelector<HTMLElement>('[data-testid="' + testId + '"]')!;
  }

  it.each(["en", "zh"] as const)("preserves the original inline count and average (%s)", async locale => {
    await render(<CompletedSpeed metrics={{ tokens: 480, seconds: 20, estimated: false }} />, locale);
    expect(speed("completed-speed").textContent).toBe(locale === "en" ? "480 tokens · avg 24 token/s" : "480 Token · 平均 24 token/s");
    expect(speed("completed-speed").dataset.rateKind).toBe("provider-average");
    expect(speed("completed-speed").title).toContain(locale === "en" ? "waiting and thinking" : "等待與思考");
    expect(container!.querySelector("details")).toBeNull();
    await render(<CompletedSpeed metrics={{ tokens: 480, seconds: 20, estimated: true }} />, locale);
    expect(speed("completed-speed").textContent).toBe(locale === "en" ? "~ 480 tokens · avg ~ 24 token/s" : "約 480 Token · 平均 約 24 token/s");
    expect(speed("completed-speed").dataset.rateKind).toBe("estimated-average");
  });

  it.each(["en", "zh"] as const)("labels a rolling generation estimate and removes a stale rate (%s)", async locale => {
    vi.useFakeTimers();
    await render(<StreamingSpeed message={baseMessage} />, locale);
    expect(speed("streaming-speed").dataset.rateAvailable).toBe("false");
    for (let i = 1; i <= 2; i++) {
      await render(<StreamingSpeed message={{ ...baseMessage, content: [{ type: "text", text: "a".repeat(i * 40) }] }} />, locale);
      await act(async () => vi.advanceTimersByTime(500));
    }
    const summary = speed("streaming-speed");
    expect(summary.dataset.rateKind).toBe("estimated-live");
    expect(summary.querySelector("[data-speed-tier]")?.textContent).toBe(locale === "en" ? "~ 20.0 token/s" : "約 20.0 token/s");
    expect(summary.querySelector("[data-speed-tier]")?.getAttribute("data-speed-tier")).toBe("mid");
    expect(summary.getAttribute("title")).toContain(locale === "en" ? "last 3 seconds" : "最近 3 秒");
    expect(container!.querySelector("details")).toBeNull();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(summary.dataset.rateAvailable).toBe("false");
    expect(summary.textContent).toContain(locale === "en" ? "speed unavailable" : "尚無速率資料");
    expect(summary.textContent).not.toContain("0 token/s");
  });

  it("shows a live badge within 250 ms once new text is observed", async () => {
    vi.useFakeTimers();
    await render(<StreamingSpeed message={baseMessage} />);
    await render(<StreamingSpeed message={{ ...baseMessage, content: [{ type: "text", text: "a".repeat(20) }] }} />);
    await act(async () => vi.advanceTimersByTime(250));
    expect(speed("streaming-speed").dataset.rateAvailable).toBe("true");
    expect(speed("streaming-speed").querySelector("[data-speed-tier]")?.textContent).toBe("~ 20.0 token/s");
  });

  it.each([1, 20, 40, 60] as const)("keeps a quiet average after a buffered reply ends (%s token/s)", async (rate) => {
    vi.useFakeTimers();
    await render(<StreamingSpeed message={{ ...baseMessage, content: [{ type: "text", text: "你好" }] }} />);
    await act(async () => vi.advanceTimersByTime(10));
    expect(speed("streaming-speed").dataset.rateAvailable).toBe("false");
    await render(<CompletedSpeed metrics={{ tokens: rate * 2, seconds: 2, estimated: false, source: "server" }} />);
    const badge = speed("completed-speed").querySelector("[data-speed-tier]");
    expect(badge).toBeNull();
    expect(speed("completed-speed").textContent).toContain(`avg ${rate} token/s`);
    expect(container!.querySelector('[data-testid="streaming-speed"]')).toBeNull();
  });

  it("uses buffered text, thinking and tool arguments only as baselines", async () => {
    vi.useFakeTimers();
    const blocks = [
      { type: "text" as const, text: "a".repeat(1000) },
      { type: "thinking" as const, thinking: "b".repeat(1000) },
      { type: "toolCall" as const, toolCallId: "tool-1", toolName: "bash", input: { command: "c".repeat(1000) } },
    ];
    for (const [timestamp, block] of blocks.entries()) {
      await render(<StreamingSpeed message={{ ...baseMessage, timestamp, content: [block] }} />);
      await act(async () => vi.advanceTimersByTime(1500));
      expect(speed("streaming-speed").dataset.rateAvailable).toBe("false");
      expect(container!.querySelector("[data-speed-tier]")).toBeNull();
    }
  });

  it.each(["thinking", "toolCall"] as const)("updates a coloured live rate as %s content arrives", async kind => {
    vi.useFakeTimers();
    const block = (length: number) => kind === "thinking"
      ? { type: "thinking" as const, thinking: "a".repeat(length) }
      : { type: "toolCall" as const, toolCallId: "tool-1", toolName: "bash", input: { command: "a".repeat(length) } };
    await render(<StreamingSpeed message={{ ...baseMessage, content: [block(0)] }} />);
    for (let step = 1; step <= 2; step++) {
      await render(<StreamingSpeed message={{ ...baseMessage, content: [block(step * 40)] }} />);
      await act(async () => vi.advanceTimersByTime(500));
    }
    expect(speed("streaming-speed").querySelector("[data-speed-tier]")?.textContent).toBe("~ 20.0 token/s");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(speed("streaming-speed").dataset.rateAvailable).toBe("false");
    expect(container!.querySelector("[data-speed-tier]")).toBeNull();
  });

  it("preserves positive rates below one token per second", async () => {
    await render(<CompletedSpeed metrics={{ tokens: 1, seconds: 10, estimated: false }} />);
    expect(speed("completed-speed").textContent).toContain("avg 0.1 token/s");
    vi.useFakeTimers();
    await render(<StreamingSpeed message={baseMessage} />);
    for (let i = 1; i <= 2; i++) {
      await render(<StreamingSpeed message={{ ...baseMessage, content: [{ type: "text", text: "a".repeat(i) }] }} />);
      await act(async () => vi.advanceTimersByTime(500));
    }
    expect(speed("streaming-speed").textContent).toContain("~ 0.5 token/s");
    expect(speed("streaming-speed").textContent).not.toContain("~ 0 token/s");
  });

  it("removes an obsolete average when timing is invalid", async () => {
    await render(<CompletedSpeed metrics={{ tokens: 480, seconds: 20, estimated: false }} />);
    expect(speed("completed-speed").textContent).toBe("480 tokens · avg 24 token/s");
    await render(<CompletedSpeed metrics={{ tokens: 480, seconds: 0, estimated: false }} />);
    expect(container!.textContent).toBe("");
    await render(<CompletedSpeed metrics={{ tokens: 200, seconds: 20, estimated: true }} />);
    expect(speed("completed-speed").textContent).toBe("~ 200 tokens · avg ~ 10 token/s");
  });

  it.each([
    { tokens: 0, seconds: 20 },
    { tokens: 480, seconds: 0 },
    { tokens: Number.NaN, seconds: 20 },
    { tokens: 480, seconds: Number.POSITIVE_INFINITY },
  ])("does not manufacture a completed rate from invalid metrics %o", async metrics => {
    await render(<CompletedSpeed metrics={{ ...metrics, estimated: false }} />);
    expect(container!.textContent).toBe("");
    expect(container!.querySelector("summary")).toBeNull();
  });
  it("uses a reconnected text snapshot as a baseline, then measures only new text", async () => {
    vi.useFakeTimers();
    const snapshot = { ...baseMessage, timestamp: 10, content: [{ type: "text" as const, text: "a".repeat(1000) }] };
    await render(<StreamingSpeed message={snapshot} enabled={false} activity="reconnecting" />);
    await act(async () => vi.advanceTimersByTime(2000));
    await render(<StreamingSpeed message={snapshot} />);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(speed("streaming-speed").dataset.rateAvailable).toBe("false");
    await render(<StreamingSpeed message={{ ...snapshot, content: [{ type: "text", text: "a".repeat(1080) }] }} />);
    await act(async () => vi.advanceTimersByTime(500));
    expect(speed("streaming-speed").textContent).toContain("~ 13.3 token/s");
    await render(<StreamingSpeed message={{ ...snapshot, timestamp: 20 }} resetKey="other-session" />);
    expect(speed("streaming-speed").dataset.rateAvailable).toBe("false");
  });

  it.each([[14.5, "slow"], [15, "mid"], [29.5, "mid"], [30, "good"], [49.5, "good"], [50, "fast"]] as const)("restores the original badge band at %s token/s", async (rate, tier) => {
    vi.useFakeTimers();
    await render(<StreamingSpeed message={baseMessage} />);
    for (let step = 1; step <= 2; step++) {
      await render(<StreamingSpeed message={{ ...baseMessage, content: [{ type: "text", text: "a".repeat(rate * 2 * step) }] }} />);
      await act(async () => vi.advanceTimersByTime(500));
    }
    expect(container!.querySelector("[data-speed-tier]")?.getAttribute("data-speed-tier")).toBe(tier);
    expect(container!.querySelector("[data-speed-tier]")?.textContent).toContain(`${rate.toFixed(1)} token/s`);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(container!.querySelector("[data-speed-tier]")).toBeNull();
  });

  it("retains server timing after restoring the original presentation", async () => {
    await render(<CompletedSpeed metrics={{ tokens: 480, seconds: 20, estimated: false, source: "server", firstContentSeconds: 1.25 }} />);
    expect(speed("completed-speed").textContent).toBe("480 tokens · avg 24 token/s");
    expect(speed("completed-speed").dataset.metricsSource).toBe("server");
    expect(container!.querySelector("details")).toBeNull();
  });
});

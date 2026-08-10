// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AssistantMessage } from "@/lib/types";
import { AssistantMessageView } from "../AssistantMessageView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseMessage: AssistantMessage = {
  role: "assistant",
  content: [],
  model: "gpt-test",
  provider: "openai-codex",
};

describe("AssistantMessageView conversation chrome", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    setLocale("en");
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function render(message: AssistantMessage, props: Partial<React.ComponentProps<typeof AssistantMessageView>> = {}) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<AssistantMessageView message={message} {...props} />));
  }

  it("renders a recovered authentication failure as compact history, not an active alert", async () => {
    await render({ ...baseMessage, stopReason: "error", errorMessage: "No API key for provider: openai-codex" }, { authRecovered: true });

    expect(container!.querySelector('[role="alert"]')).toBeNull();
    expect(container!.querySelector("details")).not.toBeNull();
    expect(container!.textContent).toContain("Connection restored");
    expect(container!.textContent).toContain("Earlier connection issue");
  });

  it("keeps usage details behind a compact disclosure", async () => {
    await render({
      ...baseMessage,
      usage: {
        input: 1060,
        output: 15,
        cacheRead: 24064,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0036 },
      },
    });

    const summary = container!.querySelector("details > summary");
    expect(summary?.textContent).toContain("Usage");
    expect(summary?.getAttribute("title")).toContain("1,060 in");
  });

  it("does not leave a dangling footer on intermediate assistant output", async () => {
    await render(
      { ...baseMessage, content: [{ type: "text", text: "Interim progress" }] },
      { showActions: false, showUsage: false, showModelLabel: false, showTimestamp: false },
    );

    expect(container!.querySelector('[data-testid="assistant-message-footer"]')).toBeNull();
    expect(container!.textContent).toContain("Interim progress");
  });

  it("summarizes billing failures and keeps the raw provider response collapsed", async () => {
    const billingUrl = "https://opencode.ai/workspace/wrk_123/billing";
    await render({
      ...baseMessage,
      stopReason: "error",
      errorMessage: `401 Insufficient balance. Manage your billing here: ${billingUrl}`,
    });

    const alert = container!.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toContain("Insufficient balance");
    expect(alert.querySelector<HTMLAnchorElement>('a[href="' + billingUrl + '"]')?.textContent).toContain("Manage billing");
    const details = alert.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false);
  });

  it("keeps shell variables literal instead of rendering them as inline math", async () => {
    await render({
      ...baseMessage,
      content: [{ type: "text", text: "Set $TGD_DIR before running setup." }],
    });

    expect(container!.textContent).toContain("$TGD_DIR");
    expect(container!.querySelector(".katex")).toBeNull();
  });

  it("rolls an entire agent loop into one expandable work log", async () => {
    const activity: AssistantMessage[] = [
      { ...baseMessage, timestamp: 2_000, content: [{ type: "thinking", thinking: "inspect" }, { type: "toolCall", toolCallId: "read-1", toolName: "read", input: { path: "src/a.ts" } }] },
      { ...baseMessage, timestamp: 4_000, content: [{ type: "toolCall", toolCallId: "edit-1", toolName: "edit", input: { path: "src/a.ts", oldText: "a", newText: "b" } }] },
    ];
    await render(
      { ...baseMessage, content: [{ type: "text", text: "Done" }] },
      {
        turnActivityMessages: activity,
        suppressActivityBlocks: true,
        turnStartedAt: 1_000,
        toolResults: new Map([
          ["read-1", { role: "toolResult", toolCallId: "read-1", content: [{ type: "text", text: "ok" }], timestamp: 3_000 }],
          ["edit-1", { role: "toolResult", toolCallId: "edit-1", content: [{ type: "text", text: "ok" }], timestamp: 5_000 }],
        ]),
      },
    );

    expect(container!.textContent).toContain("Work log");
    expect(container!.textContent).toContain("Completed");
    expect(container!.textContent).toContain("2 tools");
    expect(container!.textContent).toContain("1 file");
    expect(container!.textContent).not.toContain("src/a.ts");
    const summary = container!.querySelector<HTMLButtonElement>('section[aria-label="Work log"] > button')!;
    await act(async () => summary.click());
    expect(container!.textContent).toContain("src/a.ts");
    expect(container!.textContent).toContain("Reasoning steps");
  });

  it("opens a navigable focus surface for fenced code", async () => {
    await render({
      ...baseMessage,
      content: [{ type: "text", text: "```ts\nconst answer = 42;\n```" }],
    });

    const focus = container!.querySelector<HTMLButtonElement>('button[aria-label="Open focus mode"]');
    expect(focus).not.toBeNull();
    await act(async () => focus!.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="ts"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Wrap lines");
    expect(dialog!.querySelector('button[aria-label="Line 1"]')).not.toBeNull();
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "../ChatInput";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatInput actions", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ prompts: [] }) }));
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    vi.unstubAllGlobals();
    container?.remove();
    root = null;
    container = null;
  });

  async function render(props: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <ChatInput
        onSend={vi.fn().mockResolvedValue(true)}
        onAbort={vi.fn()}
        isStreaming={false}
        persistKey="test-session"
        {...props}
      />,
    ));
    return container.querySelector<HTMLTextAreaElement>("textarea")!;
  }

  async function fill(textarea: HTMLTextAreaElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("keeps the draft on failure and clears it only after a successful retry", async () => {
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const textarea = await render({ onSend });
    await fill(textarea, "Keep this carefully written prompt");

    const send = [...container!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Send"))!;
    await act(async () => send.click());
    expect(textarea.value).toBe("Keep this carefully written prompt");

    await act(async () => send.click());
    expect(textarea.value).toBe("");
  });

  it("defaults Enter to follow-up and honors Option+Enter for steer", async () => {
    const onFollowUp = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue(true);
    const textarea = await render({ isStreaming: true, onFollowUp, onSteer });

    await fill(textarea, "Queue this");
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onFollowUp).toHaveBeenCalledWith("Queue this", undefined);
    expect(onSteer).not.toHaveBeenCalled();

    await fill(textarea, "Interrupt now");
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true })));
    expect(onSteer).toHaveBeenCalledWith("Interrupt now", undefined);
  });

  it("keeps a streaming draft and Steer selection across pointer focus changes and parent rerenders", async () => {
    const props = { onSend: vi.fn().mockResolvedValue(true), onAbort: vi.fn(), onFollowUp: vi.fn().mockResolvedValue(true), onSteer: vi.fn().mockResolvedValue(true), isStreaming: true, persistKey: "test-session" };
    const textarea = await render(props);
    const draft = "Fixture draft only — do not send.";
    await fill(textarea, draft);
    await act(async () => textarea.focus());
    const delivery = container!.querySelector('[role="group"][aria-label="Message delivery mode"]')!;
    const steer = [...delivery.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Steer")!;
    const followUp = [...delivery.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Follow-up")!;
    expect(steer.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      steer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      textarea.blur(); steer.focus();
      steer.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      steer.click();
    });
    expect(steer.getAttribute("aria-pressed")).toBe("true");
    expect(followUp.getAttribute("aria-pressed")).toBe("false");
    expect(textarea.placeholder).toBe("Steer the current run…");
    expect(textarea.value).toBe(draft);
    await act(async () => root!.render(<ChatInput {...props} retryInfo={{ attempt: 1, maxAttempts: 3 }} />));
    expect(steer.getAttribute("aria-pressed")).toBe("true");
    expect(textarea.placeholder).toBe("Steer the current run…");
    expect(textarea.value).toBe(draft);
    expect(props.onSteer).not.toHaveBeenCalled(); expect(props.onFollowUp).not.toHaveBeenCalled();
    await act(async () => followUp.click());
    expect(followUp.getAttribute("aria-pressed")).toBe("true");
    expect(textarea.placeholder).toBe("Queue a follow-up…");
    expect(textarea.value).toBe(draft);
  });

  it("keeps mobile editing layout through composer controls but restores it after leaving", async () => {
    const textarea = await render({ isStreaming: true, onFollowUp: vi.fn(), onSteer: vi.fn() });
    const composer = textarea.closest('[data-composer-editing]')!;
    expect(composer).not.toBeNull();
    const steer = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Steer")!;
    const stop = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Stop")!;
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      // Entering from outside through a button must not move it before click.
      await act(async () => steer.focus());
      expect(composer.getAttribute("data-composer-editing")).toBe("false");
      await act(async () => textarea.focus());
      expect(composer.getAttribute("data-composer-editing")).toBe("true");
      await act(async () => steer.focus());
      expect(composer.getAttribute("data-composer-editing")).toBe("true");
      await act(async () => stop.focus());
      expect(composer.getAttribute("data-composer-editing")).toBe("true");
      await act(async () => outside.focus());
      expect(composer.getAttribute("data-composer-editing")).toBe("false");
      await act(async () => stop.focus());
      expect(composer.getAttribute("data-composer-editing")).toBe("false");
    } finally {
      outside.remove();
    }
  });

  it("ties mobile layout to the composer editing session rather than the instantaneous textarea focus", () => {
    const css = readFileSync("components/layout/AppShell.module.css", "utf8");
    expect(css.includes(":has(textarea:focus)")).toBe(false);
    expect(css.match(/:has\(\[data-composer-editing="true"\]\)/g)).toHaveLength(3);
  });

  it("renders completed file mentions as removable context chips", async () => {
    const textarea = await render({ cwd: "/project" });
    await fill(textarea, "Review @src/app.ts before release");
    expect(container!.textContent).toContain("src/app.ts");

    const remove = container!.querySelector<HTMLButtonElement>('button[aria-label="Remove context src/app.ts"]')!;
    await act(async () => remove.click());
    expect(textarea.value).toBe("Review before release");
  });

  it("sends a visible message quote with the typed follow-up", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onClearQuote = vi.fn();
    const textarea = await render({
      onSend,
      onClearQuote,
      quote: { entryId: "entry-1", role: "assistant", text: "First line\nSecond line" },
    });
    await fill(textarea, "Explain this");
    const send = [...container!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Send"))!;
    await act(async () => send.click());

    expect(onSend).toHaveBeenCalledWith("> First line\n> Second line\n\nExplain this", undefined);
    expect(onClearQuote).toHaveBeenCalledOnce();
  });

});

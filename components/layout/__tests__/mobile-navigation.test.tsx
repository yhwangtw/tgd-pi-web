// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileNavigation } from "../MobileNavigation";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MobileNavigation", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  const viewportListeners = new Set<() => void>();
  let viewport = { matches: true };
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

  beforeEach(() => {
    viewport = { matches: true };
    viewportListeners.clear();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() { return viewport.matches; },
      addEventListener: (_: string, listener: () => void) => viewportListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => viewportListeners.delete(listener),
    })));
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  async function renderNavigation(attentionUnreadCount = 0) {
    const handlers = {
      onShowChat: vi.fn(),
      onSelectView: vi.fn(),
      onOpenAnalytics: vi.fn(),
      onOpenModels: vi.fn(),
      onOpenSkills: vi.fn(),
      onOpenExtensions: vi.fn(),
      onOpenAppearance: vi.fn(),
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <StrictMode>
        <MobileNavigation
          panelView="sessions"
          panelOpen
          filePanelOpen={false}
          skillsDisabled={false}
          attentionUnreadCount={attentionUnreadCount}
          {...handlers}
        />
      </StrictMode>,
    ));
    return handlers;
  }

  it("switches between chat, primary panels, and secondary tools", async () => {
    const handlers = await renderNavigation();
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === label)!;

    await act(async () => button("Chat").click());
    expect(handlers.onShowChat).toHaveBeenCalledOnce();

    await act(async () => button("Files").click());
    expect(handlers.onSelectView).toHaveBeenCalledWith("files");

    const chat = button("Chat");
    const more = button("More");
    await act(async () => more.click());
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    expect(chat.getAttribute("aria-current")).toBeNull();
    expect(more.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Work");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Settings");

    await act(async () => button("Agents").click());
    expect(handlers.onSelectView).toHaveBeenCalledWith("agents");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows and describes unread attention before opening More", async () => {
    await renderNavigation(3);
    const more = [...container!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.endsWith("More"))!;
    expect(more.querySelector('[data-testid="mobile-attention-unread-dot"]')).not.toBeNull();
    expect(document.getElementById(more.getAttribute("aria-describedby")!)?.textContent).toBe("3 unread notifications");
  });

  it("isolates the background, wraps keyboard focus and returns to More after Escape", async () => {
    await renderNavigation();
    const more = [...container!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "More")!;
    more.focus();
    await act(async () => more.click());
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const buttons = dialog.querySelectorAll<HTMLButtonElement>("button");
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    expect(document.activeElement).toBe(first);
    expect(container!.inert).toBe(true);
    expect(container!.getAttribute("aria-hidden")).toBe("true");
    last.focus();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(first);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
    expect(document.activeElement).toBe(last);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(container!.inert).not.toBe(true);
    expect(container!.hasAttribute("aria-hidden")).toBe(false);
  });

  it("dismisses through the backdrop and releases isolation after desktop resize", async () => {
    await renderNavigation();
    const more = [...container!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "More")!;
    await act(async () => more.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-dialog-root] > button')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => more.click());
    await act(async () => { viewport.matches = false; for (const listener of viewportListeners) listener(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container!.inert).not.toBe(true);
  });
});

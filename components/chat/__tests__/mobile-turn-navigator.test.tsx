// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { MobileTurnNavigator } from "../MobileTurnNavigator";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MobileTurnNavigator", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    setLocale("en");
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it("portals a modal sheet, includes assistant bookmarks, and restores focus after navigation", async () => {
    const scroll = document.createElement("div");
    const navigate = vi.fn();
    await act(async () => root.render(<MobileTurnNavigator
      turns={[
        { entryId: "first", visibleIndex: 0, preview: "Earlier unmounted prompt", bookmarked: false, turnNumber: 1 },
        { entryId: "later", visibleIndex: 180, preview: "Current prompt", bookmarked: false, turnNumber: 91 },
      ]}
      bookmarkedMessages={[{ entryId: "answer", visibleIndex: 1, preview: "Bookmarked answer", bookmarked: true, turnNumber: 1 }]}
      scrollContainer={{ current: scroll }} messageRefs={{ current: [] }} onNavigate={navigate}
    />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Turns"]')!;
    await act(async () => { trigger.focus(); trigger.click(); });
    await act(async () => new Promise<void>(done => requestAnimationFrame(() => done())));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull(); expect(container.contains(dialog)).toBe(false);
    expect(container.getAttribute("aria-hidden")).toBe("true");
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
    expect(document.activeElement).toBe(close);
    const items = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
    const last = items.at(-1)!;
    await act(async () => { last.focus(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(items[0]);
    await act(async () => items[0].click());
    expect(dialog.textContent).toContain("Bookmarked answer");
    expect(dialog.textContent).not.toContain("Earlier unmounted prompt");
    const bookmark = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Bookmarked answer"))!;
    await act(async () => bookmark.click());
    expect(navigate).toHaveBeenCalledWith(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
    expect(container.hasAttribute("aria-hidden")).toBe(false);
    await act(async () => trigger.click());
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  });
});

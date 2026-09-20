// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconRail } from "../IconRail";
import { setLocale } from "@/lib/i18n";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); setLocale("en"); });

describe("quiet unread navigation", () => {
  it.each([0, 1, 12, 150])("keeps %i unread items accessible without growing the icon badge", async count => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    const onSelectView = vi.fn();
    await act(async () => root.render(<IconRail panelView="sessions" sidebarOpen attentionUnreadCount={count}
      onSelectView={onSelectView} onOpenAnalytics={vi.fn()} onOpenModels={vi.fn()} onOpenSkills={vi.fn()}
      skillsDisabled={false} onOpenExtensions={vi.fn()} appearanceOpen={false} onToggleAppearance={vi.fn()} />));
    const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Attention"]')!;
    expect(button.title).toBe(count ? `Attention · ${count} unread` : "Attention");
    expect(button.getAttribute("aria-label")).toBe(button.title);
    expect(button.textContent).toBe("");
    const dot = button.querySelector('[data-testid="attention-unread-dot"]');
    if (count) expect(dot?.getAttribute("aria-hidden")).toBe("true");
    else expect(dot).toBeNull();
    await act(async () => button.click());
    expect(onSelectView).toHaveBeenCalledExactlyOnceWith("attention");
  });
});

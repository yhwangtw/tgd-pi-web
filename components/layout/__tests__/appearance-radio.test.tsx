// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AppearancePanel } from "../AppearancePanel";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("keeps one tab stop per appearance group and supports arrow selection", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ enabled: false }))));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<AppearancePanel onClose={() => {}} />));
    const groups = [...container.querySelectorAll('[role="radiogroup"]')];
    expect(groups).toHaveLength(8);
    for (const group of groups) {
      expect(group.querySelectorAll('[aria-checked="true"]')).toHaveLength(1);
      expect(group.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    }
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    const group = groups[2];
    const selected = group.querySelector<HTMLButtonElement>('[aria-checked="true"]')!;
    selected.focus();
    await act(async () => selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).not.toBe(selected);
    expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

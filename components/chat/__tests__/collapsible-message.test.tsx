// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollapsibleMessage } from "../CollapsibleMessage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("collapsed historical messages", () => {
  let root: Root;
  let container: HTMLDivElement;
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 1_000 });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    container = document.createElement("div"); document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  });

  function Message({ collapsible = true }: { collapsible?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    return <CollapsibleMessage collapsible={collapsible} expanded={expanded} onToggle={() => setExpanded(value => !value)}>
      <p>Historical content</p><a href="#local-only">A link below the preview</a>
    </CollapsibleMessage>;
  }

  it("keeps the complete message and expands when a child receives keyboard focus", async () => {
    await act(async () => root.render(<Message />));
    expect(container.querySelector<HTMLElement>('[style*="max-height"]')?.style.maxHeight).toBe("380px");
    await act(async () => container.querySelector<HTMLAnchorElement>("a")!.focus());
    expect(container.querySelector('[style*="max-height"]')).toBeNull();
    expect(container.textContent).toContain("Collapse");
    expect(document.activeElement).toBe(container.querySelector("a"));
  });

  it("never clamps the latest exchange", async () => {
    await act(async () => root.render(<Message collapsible={false} />));
    expect(container.querySelector('[style*="max-height"]')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});

// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogShell } from "../DialogShell";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open filters</button>
      <DialogShell modal open={open} title="Filters" onClose={() => setOpen(false)}>
        <button type="button">First field</button>
        <button type="button">Last field</button>
      </DialogShell>
    </>
  );
}

function StackedHarness({ modal = true }: { modal?: boolean }) {
  const [parentOpen, setParentOpen] = useState(true);
  const [childOpen, setChildOpen] = useState(false);
  return (
    <>
      <button type="button">Background action</button>
      <DialogShell modal={modal} open={parentOpen} title="Parent" onClose={() => setParentOpen(false)}>
        <button type="button" onClick={() => setChildOpen(true)}>Open child</button>
      </DialogShell>
      <DialogShell modal={modal} open={childOpen} title="Child" onClose={() => setChildOpen(false)}>
        <button type="button" onClick={() => setParentOpen(false)}>Close parent first</button>
        <button type="button" onClick={() => setChildOpen(false)}>Close child</button>
      </DialogShell>
    </>
  );
}

describe("DialogShell", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    vi.restoreAllMocks();
    root = null;
    container?.remove();
    container = null;
    document.querySelectorAll("[data-dialog-root]").forEach((element) => element.remove());
  });

  it("defaults to a modeless, collapsible panel without losing a form draft", async () => {
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root?.render(<><button id="outside">Keep working</button><DialogShell open title="Settings" onClose={() => {}}><input defaultValue="unfinished" /></DialogShell></>));
    expect(document.querySelector("[data-dialog-root]")?.getAttribute("data-placement")).toBe("center");
    const outside = container.querySelector<HTMLButtonElement>("#outside")!;
    outside.focus();
    expect(container.inert).not.toBe(true);
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    const collapse = document.querySelector<HTMLButtonElement>('[aria-label="Minimize panel"]')!;
    await act(async () => collapse.click());
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe("unfinished");
    expect(document.querySelector('[role="dialog"] [hidden]')).not.toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(collapse.getAttribute("aria-expanded")).toBe("false");
    const expand = document.querySelector<HTMLButtonElement>('[aria-label="Expand panel"]')!;
    expect(expand.title).toBe("Expand panel");
    await act(async () => expand.click());
    expect(document.querySelector('[role="dialog"] [hidden]')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe("unfinished");
  });

  async function gesture(target: Element, pointerType = "mouse", button = 0) {
    await act(async () => {
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType, button, isPrimary: true }));
      target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType, button, isPrimary: true }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, button, detail: 1 }));
    });
  }

  async function mount(view: React.ReactNode) {
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(view));
  }

  it.each([false, true])("dismisses modal=%s on outside mouse clicks and touch taps, but not inside", async (modal) => {
    const close = vi.fn();
    await mount(<DialogShell open modal={modal} title="Settings" onClose={close}><input defaultValue="draft" /></DialogShell>);
    await gesture(document.querySelector("input")!);
    expect(close).not.toHaveBeenCalled();
    const outside = modal ? document.querySelector("[data-dialog-root]")! : document.body;
    await gesture(outside);
    await gesture(outside, "touch");
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("ignores drags from inside, canceled touches and secondary buttons", async () => {
    const close = vi.fn();
    await mount(<DialogShell open title="Settings" onClose={close}><input defaultValue="draft" /></DialogShell>);
    await act(async () => {
      document.querySelector("input")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "touch", isPrimary: true }));
      document.body.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    await gesture(document.body, "mouse", 2);
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps portaled child controls interactive even when they stop propagation", async () => {
    const close = vi.fn();
    const selected = vi.fn();
    await mount(<DialogShell open title="Settings" onClose={close}>
      {createPortal(<button id="portaled-option" onPointerDown={event => event.stopPropagation()} onClick={selected}>Choose</button>, document.body)}
    </DialogShell>);
    await gesture(document.querySelector("#portaled-option")!);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    await gesture(document.body);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("dismisses only the top dialog when modal=%s", async (modal) => {
    await mount(<StackedHarness modal={modal} />);
    const openChild = [...document.querySelectorAll("button")].find(button => button.textContent === "Open child")!;
    await gesture(openChild);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await gesture(document.querySelectorAll("[data-dialog-root]")[1]);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("Parent");
    await gesture(document.querySelector("[data-dialog-root]")!);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([false, true])("honors busy state and uses the latest close handler when modal=%s", async (modal) => {
    const close = vi.fn(), updated = vi.fn();
    await mount(<DialogShell open modal={modal} title="Saving" canClose={false} onClose={close}>Saving</DialogShell>);
    const outside = document.querySelector("[data-dialog-root]")!;
    await gesture(outside);
    await act(async () => document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.disabled).toBe(true);
    await act(async () => root!.render(<DialogShell open modal={modal} title="Saved" onClose={updated}>Saved</DialogShell>));
    await gesture(outside);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("does not dismiss on the opening click or reopen when its trigger toggles closed", async () => {
    function ToggleHarness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(value => !value)}>Toggle</button>
        <DialogShell open={open} title="Settings" onClose={() => setOpen(false)}>Content</DialogShell></>;
    }
    await mount(<ToggleHarness />);
    const trigger = container!.querySelector("button")!;
    await gesture(trigger);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await gesture(trigger);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps the draft when discard is canceled and closes only when confirmed", async () => {
    const close = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await mount(<DialogShell open title="Editor" hasUnsavedChanges onClose={close}><input defaultValue="unfinished" /></DialogShell>);
    await gesture(document.body);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("unfinished");
    await gesture(document.querySelector('[aria-label="Close"]')!);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await act(async () => document.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("isolates the background, closes with Escape, and restores focus", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    trigger.focus();
    await act(async () => trigger.click());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(container.inert).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.inert).not.toBe(true);
    expect(container.getAttribute("aria-hidden")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not restore focus over ongoing background typing when a panel closes", async () => {
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    const view = (open: boolean) => <><input aria-label="Composer" /><DialogShell open={open} title="Review" onClose={() => {}}><input aria-label="Review notes" /></DialogShell></>;
    await act(async () => root?.render(view(false)));
    const composer = container.querySelector("input")!; composer.focus();
    await act(async () => root?.render(view(true)));
    expect(document.activeElement).toBe(composer);
    document.querySelector<HTMLInputElement>('[aria-label="Review notes"]')!.focus();
    composer.focus();
    await act(async () => root?.render(view(false)));
    expect(document.activeElement).toBe(composer);
  });

  it("honors an explicit initial field without trapping focus in a modeless panel", async () => {
    function SearchHarness() {
      const [open, setOpen] = useState(false);
      const inputRef = useRef<HTMLInputElement>(null);
      return <><button onClick={() => setOpen(true)}>Open search</button>
        <DialogShell open={open} title="Search" initialFocusRef={inputRef} onClose={() => setOpen(false)}>
          <input ref={inputRef} aria-label="Search items" />
        </DialogShell></>;
    }
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(<SearchHarness />));
    const trigger = container.querySelector("button")!; trigger.focus();
    await act(async () => trigger.click());
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search items"]')!;
    expect(document.activeElement).toBe(input);
    expect(container.inert).not.toBe(true);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps stacked dialogs isolated and restores the app regardless of close order", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<StackedHarness />));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    const parentRoot = document.querySelector<HTMLElement>('[data-dialog-root]')!;
    const openChild = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Open child")!;
    await act(async () => openChild.click());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(parentRoot.inert).toBe(true);
    expect([...document.querySelectorAll<HTMLElement>('[data-dialog-root]')][1].inert).not.toBe(true);
    expect(container.inert).toBe(true);

    const closeParent = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Close parent first")!;
    await act(async () => closeParent.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.inert).toBe(true);

    const closeChild = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Close child")!;
    await act(async () => closeChild.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(container.inert).not.toBe(true);
    expect(container.getAttribute("aria-hidden")).toBeNull();
  });

  it("returns interaction to the parent after closing the top dialog", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<StackedHarness />));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    const openChild = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Open child")!;
    await act(async () => openChild.click());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    const [parentRoot, childRoot] = [...document.querySelectorAll<HTMLElement>('[data-dialog-root]')];
    expect(parentRoot.inert).toBe(true);
    expect(childRoot.inert).not.toBe(true);

    const closeChild = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Close child")!;
    await act(async () => closeChild.click());

    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(parentRoot.inert).not.toBe(true);
    expect(parentRoot.getAttribute("aria-hidden")).toBeNull();
    expect(container.inert).toBe(true);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(container.inert).not.toBe(true);
    expect(container.getAttribute("aria-hidden")).toBeNull();
  });
});

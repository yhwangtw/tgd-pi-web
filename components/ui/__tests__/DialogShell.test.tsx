// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { DialogShell } from "../DialogShell";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open filters</button>
      <DialogShell open={open} title="Filters" onClose={() => setOpen(false)}>
        <button type="button">First field</button>
        <button type="button">Last field</button>
      </DialogShell>
    </>
  );
}

function StackedHarness() {
  const [parentOpen, setParentOpen] = useState(true);
  const [childOpen, setChildOpen] = useState(false);
  return (
    <>
      <button type="button">Background action</button>
      <DialogShell open={parentOpen} title="Parent" onClose={() => setParentOpen(false)}>
        <button type="button" onClick={() => setChildOpen(true)}>Open child</button>
      </DialogShell>
      <DialogShell open={childOpen} title="Child" onClose={() => setChildOpen(false)}>
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
    root = null;
    container?.remove();
    container = null;
    document.querySelectorAll("[data-dialog-root]").forEach((element) => element.remove());
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

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
      <DialogShell modal open={open} title="Filters" onClose={() => setOpen(false)}>
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
      <DialogShell modal open={parentOpen} title="Parent" onClose={() => setParentOpen(false)}>
        <button type="button" onClick={() => setChildOpen(true)}>Open child</button>
      </DialogShell>
      <DialogShell modal open={childOpen} title="Child" onClose={() => setChildOpen(false)}>
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

  it("defaults to a modeless, collapsible panel without losing a form draft", async () => {
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root?.render(<><button id="outside">Keep working</button><DialogShell open title="Settings" onClose={() => {}}><input defaultValue="unfinished" /></DialogShell></>));
    const outside = container.querySelector<HTMLButtonElement>("#outside")!;
    outside.focus();
    expect(container.inert).not.toBe(true);
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    const collapse = document.querySelector<HTMLButtonElement>('[aria-label="Minimize panel"]')!;
    await act(async () => collapse.click());
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe("unfinished");
    expect(document.querySelector('[role="dialog"] [hidden]')).not.toBeNull();
    expect(document.activeElement).toBe(outside);
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

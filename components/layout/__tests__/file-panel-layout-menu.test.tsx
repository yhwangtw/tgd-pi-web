// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FilePanelLayoutMenu } from "../FilePanelLayoutMenu";

vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const resetWidth = vi.fn();
const toggleExpanded = vi.fn();
const returnToOrigin = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<FilePanelLayoutMenu className="control" expanded={false}
    onResetWidth={resetWidth} onToggleExpanded={toggleExpanded}
    returnAction={{ label: "Back to message", onReturn: returnToOrigin }} />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function openMenu() {
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="files.panelLayout"]')!;
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  return document.querySelector<HTMLElement>('[role="menu"]')!;
}

it("keeps reset, expand and the exact origin label in a portalled keyboard menu", async () => {
  const menu = await openMenu();
  expect(menu).not.toBeNull();
  expect(host.contains(menu)).toBe(false);
  expect(menu.getAttribute("aria-label")).toBe("files.panelLayout");
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  expect(items.map(item => item.textContent)).toEqual(["Back to message", "topbar.expandFilePanel", "topbar.resetFilePanel"]);
  expect(document.activeElement).toBe(items[0]);
  await act(async () => items[2].click());
  expect(resetWidth).toHaveBeenCalledOnce();
  expect(toggleExpanded).not.toHaveBeenCalled();
  expect(returnToOrigin).not.toHaveBeenCalled();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("offers Restore for an expanded panel and retains Escape focus restoration", async () => {
  await act(async () => root.render(<FilePanelLayoutMenu className="control" expanded
    onResetWidth={resetWidth} onToggleExpanded={toggleExpanded} />));
  let menu = await openMenu();
  const restore = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(item => item.textContent === "topbar.restoreFilePanel")!;
  expect(restore).toBeTruthy();
  await act(async () => restore.click());
  expect(toggleExpanded).toHaveBeenCalledOnce();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  menu = await openMenu();
  await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector('[aria-label="files.panelLayout"]'));
});

it("closes the menu before returning to an origin that can hide the pane", async () => {
  const menu = await openMenu();
  const origin = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  await act(async () => origin.click());
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(returnToOrigin).not.toHaveBeenCalled();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(returnToOrigin).toHaveBeenCalledOnce();
});

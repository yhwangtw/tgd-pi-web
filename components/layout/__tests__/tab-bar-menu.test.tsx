// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TabBar } from "../TabBar";

vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let anchorLeft: number;
let anchorTop: number;
const tabs = [
  { id: "readme", label: "README.md", filePath: "/demo/README.md" },
  { id: "source", label: "index.ts", filePath: "/demo/index.ts" },
];

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  anchorLeft = 310; anchorTop = 250;
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 340);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const menu = this.getAttribute("role") === "menu";
    const x = menu ? 0 : anchorLeft;
    const y = menu ? 0 : anchorTop;
    const width = menu ? 150 : 70;
    const height = menu ? 220 : 36;
    return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() {} };
  });
  await act(async () => root.render(<TabBar tabs={tabs} activeTabId="readme" onSelectTab={vi.fn()} onCloseTab={vi.fn()}
    onReveal={vi.fn()} onTogglePin={vi.fn()} onOpenSplit={vi.fn()} onCloseOthers={vi.fn()} onCloseAll={vi.fn()} />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function key(target: Element, value: string, shiftKey = false) {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })));
}

async function openAtEdge() {
  await act(async () => host.querySelector('[role="tab"]')!.dispatchEvent(new MouseEvent("contextmenu", { clientX: 376, clientY: 280, bubbles: true, cancelable: true })));
  return document.querySelector<HTMLElement>('[role="menu"]')!;
}

it("portals the menu out of the clipped tab bar and keeps every action within the viewport", async () => {
  const menu = await openAtEdge();
  expect(host.contains(menu)).toBe(false);
  expect(menu.parentElement).toBe(document.body);
  expect(menu.style.left).toBe("232px");
  expect(menu.style.top).toBe("112px");
  expect(document.activeElement).toBe(menu.querySelector('[role="menuitem"]'));
});

it("follows the tab when its strip scrolls and reclamps after a viewport resize", async () => {
  const menu = await openAtEdge();
  anchorLeft = 20; anchorTop = 10;
  await act(async () => host.dispatchEvent(new Event("scroll")));
  expect(menu.style.left).toBe("86px");
  expect(menu.style.top).toBe("40px");
  vi.stubGlobal("innerWidth", 220);
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(menu.style.left).toBe("62px");
});

it.each(["ContextMenu", "F10"])("supports %s, menu arrow navigation, and Escape focus restoration", async triggerKey => {
  const tab = host.querySelector<HTMLButtonElement>('[role="tab"]')!;
  tab.focus();
  await key(tab, triggerKey, triggerKey === "F10");
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  const items = menu.querySelectorAll('[role="menuitem"]');
  await key(items[0], "ArrowDown");
  expect(document.activeElement).toBe(items[1]);
  await key(items[1], "End");
  expect(document.activeElement).toBe(items[items.length - 1]);
  await key(items[items.length - 1], "Escape");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(tab);
  expect(tab.getAttribute("aria-expanded")).toBe("false");
});

it("dismisses on an outside pointer without leaving focus on a removed menu item", async () => {
  const menu = await openAtEdge();
  const backdrop = menu.previousElementSibling!;
  await act(async () => backdrop.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector('[role="tab"]'));
});

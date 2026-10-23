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


it("reveals the complete active tab after switching files or narrowing the strip without moving focus", async () => {
  let resized: (() => void) | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const strip = host.querySelector<HTMLElement>('[data-testid="file-tab-strip"]')!;
  let stripWidth = 300;
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    const file = this.dataset.fileTab;
    const x = file === "source" ? 240 - strip.scrollLeft : file === "readme" ? -strip.scrollLeft : 0;
    const width = file ? 180 : stripWidth;
    return { x, y: 0, left: x, top: 0, right: x + width, bottom: 36, width, height: 36, toJSON() {} };
  });
  const background = document.createElement("input"); host.append(background); background.focus();
  await act(async () => root.render(<TabBar tabs={tabs} activeTabId="source" onSelectTab={vi.fn()} onCloseTab={vi.fn()} />));
  expect(strip.scrollLeft).toBe(120);
  expect(document.activeElement).toBe(background);
  stripWidth = 220;
  await act(async () => resized?.());
  expect(strip.scrollLeft).toBe(200);
  expect(document.activeElement).toBe(background);
  await act(async () => root.render(<TabBar tabs={tabs} activeTabId="readme" onSelectTab={vi.fn()} onCloseTab={vi.fn()} />));
  expect(strip.scrollLeft).toBe(0);
  expect(disconnect).toHaveBeenCalled();
});


it.each([
  { close: "readme", selected: "source" },
  { close: "source", selected: "readme" },
])("closing $close keeps selection and focus on $selected", async ({ close, selected }) => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  await act(async () => root.render(<TabBar tabs={tabs} activeTabId="readme" onSelectTab={onSelect} onCloseTab={onClose} />));
  const button = host.querySelector<HTMLButtonElement>(`[data-close-file-tab="${close}"]`)!;
  // Close controls stay independently named and never become nested buttons.
  expect(button.getAttribute("aria-label")).toContain(tabs.find(tab => tab.id === close)!.label);
  expect(button.closest('[role="tab"], [role="tablist"]')).toBeNull();
  button.focus();
  await act(async () => button.click());
  expect(onClose).toHaveBeenCalledExactlyOnceWith(close);
  if (close === "readme") expect(onSelect).toHaveBeenCalledExactlyOnceWith(selected);
  else expect(onSelect).not.toHaveBeenCalled();
  expect(document.activeElement?.id).toBe(`file-tab-${selected}`);
});

it.each(['[data-file-tab="source"] [role="tab"]', '[data-close-file-tab="source"]'])(
  "middle-click closes once without auto-scroll or changing selection: %s", async selector => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    await act(async () => root.render(<TabBar tabs={tabs} activeTabId="readme" onSelectTab={onSelect} onCloseTab={onClose} />));
    const target = host.querySelector(selector)!;
    const down = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true });
    await act(async () => target.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    await act(async () => target.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })));
    expect(onClose).toHaveBeenCalledExactlyOnceWith("source");
    expect(onSelect).not.toHaveBeenCalled();
  },
);

it("keeps arrow, Home and End navigation on file tabs", async () => {
  const onSelect = vi.fn();
  await act(async () => root.render(<TabBar tabs={tabs} activeTabId="readme" onSelectTab={onSelect} onCloseTab={vi.fn()} />));
  const first = host.querySelector<HTMLButtonElement>('#file-tab-readme')!;
  const last = host.querySelector<HTMLButtonElement>('#file-tab-source')!;
  first.focus();
  await key(first, "ArrowLeft");
  expect(onSelect).toHaveBeenLastCalledWith("source");
  expect(document.activeElement).toBe(last);
  await key(last, "ArrowRight");
  expect(onSelect).toHaveBeenLastCalledWith("readme");
  expect(document.activeElement).toBe(first);
  await key(first, "End");
  expect(document.activeElement).toBe(last);
  await key(last, "Home");
  expect(document.activeElement).toBe(first);
});

it("reorders dragged files and forgets a cancelled drag", async () => {
  const onReorder = vi.fn();
  await act(async () => root.render(<TabBar tabs={tabs} activeTabId="readme" onSelectTab={vi.fn()} onCloseTab={vi.fn()} onReorder={onReorder} />));
  const first = host.querySelector('[data-file-tab="readme"]')!;
  const last = host.querySelector('[data-file-tab="source"]')!;
  const drag = async (target: Element, type: string) => act(async () => target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })));
  await drag(first, "dragstart");
  await drag(last, "drop");
  expect(onReorder).toHaveBeenCalledExactlyOnceWith("readme", 1);
  onReorder.mockClear();
  await drag(first, "dragstart");
  await drag(first, "dragend");
  await drag(last, "drop");
  expect(onReorder).not.toHaveBeenCalled();
});

function setStripSize(width: number, contentWidth: number) {
  const strip = host.querySelector<HTMLElement>('[data-testid="file-tab-strip"]')!;
  Object.defineProperty(strip, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(strip, "scrollWidth", { configurable: true, value: contentWidth });
  return strip;
}

it("keeps overflow arrows outside the clipped strip and reaches both ends", async () => {
  const strip = setStripSize(180, 720);
  await act(async () => root.render(<TabBar tabs={[...tabs]} activeTabId="readme" onSelectTab={vi.fn()} onCloseTab={vi.fn()} />));
  const left = host.querySelector<HTMLButtonElement>('[aria-label="tabs.scrollLeft"]')!;
  const right = host.querySelector<HTMLButtonElement>('[aria-label="tabs.scrollRight"]')!;
  expect(strip.contains(left)).toBe(false);
  expect(strip.contains(right)).toBe(false);
  expect(left.disabled).toBe(true);
  expect(right.disabled).toBe(false);
  await act(async () => right.click());
  expect(strip.scrollLeft).toBe(135);
  expect(left.disabled).toBe(false);
  for (let count = 0; count < 4; count++) await act(async () => right.click());
  expect(strip.scrollLeft).toBe(540);
  expect(right.disabled).toBe(true);
  for (let count = 0; count < 4; count++) await act(async () => left.click());
  expect(strip.scrollLeft).toBe(0);
  expect(left.disabled).toBe(true);
});

it("allows a regular mouse wheel to reveal hidden files without hijacking zoom or boundary scrolling", async () => {
  const strip = setStripSize(180, 720);
  await act(async () => root.render(<TabBar tabs={[...tabs]} activeTabId="readme" onSelectTab={vi.fn()} onCloseTab={vi.fn()} />));
  const wheel = async (init: WheelEventInit) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    await act(async () => strip.dispatchEvent(event));
    return event;
  };
  expect((await wheel({ deltaY: 64 })).defaultPrevented).toBe(true);
  expect(strip.scrollLeft).toBe(64);
  expect((await wheel({ deltaY: 80, ctrlKey: true })).defaultPrevented).toBe(false);
  expect((await wheel({ deltaX: 80, deltaY: 1 })).defaultPrevented).toBe(false);
  expect(strip.scrollLeft).toBe(64);
  await wheel({ deltaY: 1000 });
  expect(strip.scrollLeft).toBe(540);
  expect((await wheel({ deltaY: 64 })).defaultPrevented).toBe(false);
  expect(strip.scrollLeft).toBe(540);
});

it("lists every open file outside the clipped toolbar and switches to a hidden file", async () => {
  const manyTabs = Array.from({ length: 8 }, (_, index) => ({
    id: `file-${index}`, label: "index.ts", filePath: `/demo/project-${index}/index.ts`,
  }));
  const onSelect = vi.fn();
  await act(async () => root.render(<TabBar tabs={manyTabs} activeTabId="file-0" onSelectTab={onSelect} onCloseTab={vi.fn()} />));
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="tabs.showAll"]')!;
  expect(host.querySelector('[data-testid="file-tab-strip"]')!.contains(trigger)).toBe(false);
  await key(trigger, "Enter");
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  expect(menu).not.toBeNull();
  expect(host.contains(menu)).toBe(false);
  const choices = menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
  expect(choices).toHaveLength(8);
  expect(choices[0].getAttribute("aria-checked")).toBe("true");
  expect(choices[7].textContent).toContain("/demo/project-7/index.ts");
  await act(async () => choices[7].click());
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("file-7");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("opens the file list with the keyboard and dismisses it with Escape", async () => {
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="tabs.showAll"]')!;
  trigger.focus();
  await key(trigger, "ArrowDown");
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  expect(menu).not.toBeNull();
  await key(menu, "Escape");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("offers move-left/right from a touch-accessible action trigger and skips disabled edge actions", async () => {
  const reorder = vi.fn();
  const select = vi.fn();
  await act(async () => root.render(<TabBar tabs={tabs} activeTabId="readme" onSelectTab={select} onCloseTab={vi.fn()} onReorder={reorder} />));
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="tabs.actions"]')!;
  expect(host.querySelector('[data-testid="file-tab-strip"]')!.contains(trigger)).toBe(false);
  await act(async () => trigger.click());
  let menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  const left = Array.from(menu.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "tabs.moveLeft")!;
  const right = Array.from(menu.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "tabs.moveRight")!;
  expect(left.disabled).toBe(true);
  expect(document.activeElement).toBe(right);
  await act(async () => right.click());
  expect(reorder).toHaveBeenCalledExactlyOnceWith("readme", 1);
  expect(select).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(host.querySelector('[role="tab"]'));
  await key(host.querySelectorAll('[role="tab"]')[1], "ContextMenu");
  menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  const otherLeft = Array.from(menu.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "tabs.moveLeft")!;
  await act(async () => otherLeft.click());
  expect(reorder).toHaveBeenLastCalledWith("source", 0);
});

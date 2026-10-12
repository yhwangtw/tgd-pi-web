// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRightPanelWidth } from "../useRightPanelWidth";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function Harness() {
  const { panelRef, rightWidth, draggingRight, startRightResize, resizeRightByKeyboard } = useRightPanelWidth();
  return <div ref={panelRef} data-width={rightWidth ?? "default"} data-dragging={draggingRight}><div role="separator" tabIndex={0} onPointerDown={startRightResize} onKeyDown={resizeRightByKeyboard} /></div>;
}
beforeEach(async () => {
  localStorage.removeItem("pi-right-width");
  vi.stubGlobal("innerWidth", 1200);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
  host.firstElementChild!.getBoundingClientRect = () => ({ width: 500 } as DOMRect);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.removeItem("pi-right-width"); vi.unstubAllGlobals(); });
async function press(key: string, shiftKey = false) {
  await act(async () => host.querySelector('[role="separator"]')!.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })));
}
it("resizes from the actual panel edge and persists keyboard changes", async () => {
  await press("ArrowLeft");
  expect(host.firstElementChild!.getAttribute("data-width")).toBe("524");
  expect(localStorage.getItem("pi-right-width")).toBe("524");
  await press("ArrowRight", true);
  expect(host.firstElementChild!.getAttribute("data-width")).toBe("420");
  await press("Home");
  expect(host.firstElementChild!.getAttribute("data-width")).toBe("default");
  expect(localStorage.getItem("pi-right-width")).toBeNull();
});
it("clamps a narrow panel and leaves unrelated navigation keys alone", async () => {
  host.firstElementChild!.getBoundingClientRect = () => ({ width: 321 } as DOMRect);
  await press("ArrowRight", true);
  expect(localStorage.getItem("pi-right-width")).toBe("320");
  await press("Tab");
  expect(localStorage.getItem("pi-right-width")).toBe("320");
});

async function pointer(type: string, target: EventTarget, clientX = 600, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: pointerId === 1 }, pointerType: { value: "touch" } });
  await act(async () => target.dispatchEvent(event));
}
it.each(["pointercancel", "lostpointercapture", "blur", "second pointer"])("cancels an interrupted drag (%s), restores width, and allows another drag", async reason => {
  const separator = host.querySelector('[role="separator"]')!;
  await press("ArrowLeft");
  await pointer("pointerdown", separator);
  await pointer("pointermove", window, 550);
  expect(host.firstElementChild!.getAttribute("data-width")).toBe("650");
  if (reason === "blur") await act(async () => window.dispatchEvent(new Event("blur")));
  else if (reason === "second pointer") await pointer("pointerdown", window, 600, 2);
  else await pointer(reason, reason === "lostpointercapture" ? separator : window);
  expect(host.firstElementChild!.getAttribute("data-dragging")).toBe("false");
  expect(host.firstElementChild!.getAttribute("data-width")).toBe("524");
  expect(localStorage.getItem("pi-right-width")).toBe("524");
  await pointer("pointerdown", separator);
  await pointer("pointermove", window, 620);
  await pointer("pointerup", window, 620);
  expect(localStorage.getItem("pi-right-width")).toBe("580");
});
it("fits a saved width when the viewport shrinks and restores the preference when enlarged", async () => {
  await press("ArrowLeft");
  vi.stubGlobal("innerWidth", 720);
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(host.firstElementChild!.getAttribute("data-width")).toBe("440");
  expect(localStorage.getItem("pi-right-width")).toBe("524");
  vi.stubGlobal("innerWidth", 1200);
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(host.firstElementChild!.getAttribute("data-width")).toBe("524");
});
it("cleans up an active drag on unmount without persisting an unfinished gesture", async () => {
  await pointer("pointerdown", host.querySelector('[role="separator"]')!);
  await pointer("pointermove", window, 600);
  await act(async () => { root.unmount(); root = createRoot(host); root.render(<Harness />); });
  await pointer("pointerup", window);
  expect(localStorage.getItem("pi-right-width")).toBeNull();
  expect(host.firstElementChild!.getAttribute("data-dragging")).toBe("false");
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRightPanelWidth } from "../useRightPanelWidth";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function Harness() {
  const { rightWidth, resizeRightByKeyboard } = useRightPanelWidth();
  return <div data-width={rightWidth ?? "default"}><div role="separator" tabIndex={0} onKeyDown={resizeRightByKeyboard} /></div>;
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

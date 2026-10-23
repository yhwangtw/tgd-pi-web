// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageViewer } from "../ImageViewer";

vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/useFileWatch", () => ({ useFileWatch: () => ({ watching: false, refreshTrigger: 0 }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let image: HTMLImageElement;
let captures: Set<number>;

beforeEach(async () => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ImageViewer filePath="/fixture/image.png" />));
  image = host.querySelector("img")!;
  captures = new Set();
  image.setPointerCapture = vi.fn(id => captures.add(id));
  image.hasPointerCapture = id => captures.has(id);
  image.releasePointerCapture = vi.fn(id => captures.delete(id));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
async function pointer(type: string, id: number, x: number, y = 0, isPrimary = true) {
  const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: "touch" }, isPrimary: { value: isPrimary } });
  await act(async () => image.dispatchEvent(event));
}

it.each(["pointercancel", "lostpointercapture", "pointerup", "blur"])("clears image pan on %s, ignores a second finger and permits another drag", async ending => {
  await act(async () => button("files.zoomIn").click());
  await pointer("pointerdown", 1, 10, 20);
  await pointer("pointerdown", 2, 90, 90, false);
  await pointer("pointermove", 2, 150, 150, false);
  expect(image.style.transform).toContain("translate(0px, 0px)");
  await pointer("pointermove", 1, 40, 50);
  expect(image.style.transform).toContain("translate(30px, 30px)");
  if (ending === "blur") await act(async () => window.dispatchEvent(new Event("blur")));
  else await pointer(ending, 1, 999);
  expect(captures.size).toBe(0);
  await pointer("pointermove", 1, 200, 200);
  expect(image.style.transform).toContain("translate(30px, 30px)");
  await pointer("pointerdown", 3, 10, 20);
  await pointer("pointermove", 3, 20, 40);
  expect(image.style.transform).toContain("translate(40px, 50px)");
});

it("offers bounded zoom buttons and clears panning on reset and file change", async () => {
  expect(button("files.zoomOut").disabled).toBe(true);
  for (let i = 0; i < 14; i++) await act(async () => button("files.zoomIn").click());
  expect(image.style.transform).toContain("scale(8)");
  expect(button("files.zoomIn").disabled).toBe(true);
  await pointer("pointerdown", 1, 10);
  await act(async () => button("files.resetZoom").click());
  expect(captures.size).toBe(0);
  await pointer("pointermove", 1, 100);
  expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
  await act(async () => button("files.zoomIn").click());
  await pointer("pointerdown", 2, 10);
  await act(async () => root.render(<ImageViewer filePath="/fixture/next.png" />));
  expect(captures.size).toBe(0);
  expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
});

it("releases capture when the image viewer unmounts", async () => {
  await act(async () => button("files.zoomIn").click());
  await pointer("pointerdown", 9, 10);
  await act(async () => root.render(null));
  expect(captures.size).toBe(0);
});

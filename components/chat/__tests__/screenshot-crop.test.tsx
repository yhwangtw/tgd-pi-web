// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ScreenshotDialog from "../ScreenshotDialog";
import { setLocale } from "@/lib/i18n";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const preview = { dataUrl: "data:image/png;base64,b3JpZ2luYWw=", width: 1280, height: 720 };
const attached = vi.fn(); const close = vi.fn(); const draw = vi.fn();
let host: HTMLDivElement; let root: Root; let stage: HTMLDivElement;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
const pointer = async (type: string, x: number, y: number, id = 1, pointerType = "mouse") => {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 });
  Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType } });
  await act(async () => stage.dispatchEvent(event));
};
const select = async () => { await pointer("pointerdown", 490, 290); await pointer("pointermove", 170, 110); await pointer("pointerup", 170, 110); };
beforeEach(async () => {
  vi.clearAllMocks(); setLocale("en");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,Y3JvcA==");
  await act(async () => root.render(<ScreenshotDialog preview={preview} help={null} disabled={false} onClose={close} onRetake={vi.fn()} onAttach={attached} onChooseFile={vi.fn()} />));
  stage = document.querySelector('[data-testid="screenshot-crop"]')!;
  stage.getBoundingClientRect = () => ({ left: 10, top: 20, width: 640, height: 360, right: 650, bottom: 380, x: 10, y: 20, toJSON() {} });
  stage.setPointerCapture = vi.fn(); stage.hasPointerCapture = () => true; stage.releasePointerCapture = vi.fn();
  const image = stage.querySelector("img")!;
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 1280 }, naturalHeight: { value: 720 } });
  await act(async () => image.dispatchEvent(new Event("load")));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("allows reverse drags on a scaled image and attaches only the selected PNG", async () => {
  await select(); await click("Attach selection");
  expect(attached).toHaveBeenCalledWith({ dataUrl: "data:image/png;base64,Y3JvcA==", width: 640, height: 360 });
  expect(draw).toHaveBeenCalledWith(stage.querySelector("img"), 320, 180, 640, 360, 0, 0, 640, 360);
  expect(close).toHaveBeenCalledOnce();
});
it("supports touch selection and restores the original image explicitly", async () => {
  await pointer("pointerdown", 170, 110, 8, "touch"); await pointer("pointermove", 490, 290, 8, "touch"); await pointer("pointerup", 490, 290, 8, "touch");
  expect(button("Attach selection")).toBeTruthy(); await click("Full image"); await click("Attach screenshot");
  expect(attached).toHaveBeenCalledWith(preview); expect(draw).not.toHaveBeenCalled();
});
it("restores the previous selection on cancellation or a click without area and ignores another pointer", async () => {
  await select(); await pointer("pointerdown", 10, 20); await pointer("pointermove", 650, 380, 2); await pointer("pointercancel", 650, 380, 2);
  expect(document.body.textContent).toContain("640 × 360");
  await pointer("pointermove", 650, 380); await pointer("pointercancel", 650, 380);
  expect(document.body.textContent).toContain("640 × 360");
  await pointer("pointerdown", 10, 20); await pointer("pointerup", 10, 20);
  await click("Attach selection"); expect(attached.mock.calls[0][0]).toMatchObject({ width: 640, height: 360 });
});
it("lets keyboard users select, move and resize the crop", async () => {
  await act(async () => stage.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  await act(async () => stage.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true })));
  await click("Attach selection");
  expect(draw).toHaveBeenCalledWith(stage.querySelector("img"), 321, 180, 641, 360, 0, 0, 641, 360);
});
it("does not attach the full screenshot if crop encoding fails", async () => {
  await select(); vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue("data:,"); await click("Attach selection");
  expect(attached).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')!.textContent).toContain("Crop failed");
});

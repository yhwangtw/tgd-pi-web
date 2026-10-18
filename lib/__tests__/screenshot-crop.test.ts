// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { adjustCrop, cropPoint, cropRectangle, cropScreenshot } from "../screenshot-crop";

afterEach(() => vi.restoreAllMocks());
it("maps scaled preview coordinates into source pixels and clamps outside drags", () => {
  const display = { left: 10, top: 20, width: 640, height: 360 };
  const image = { width: 1280, height: 720 };
  expect(cropPoint(170, 110, display, image)).toEqual({ x: 320, y: 180 });
  expect(cropPoint(-200, 2000, display, image)).toEqual({ x: 0, y: 720 });
  expect(cropRectangle({ x: 960, y: 540 }, { x: 320, y: 180 })).toEqual({ x: 320, y: 180, width: 640, height: 360 });
});
it("keeps keyboard movement and resizing inside the image with a minimum one-pixel selection", () => {
  const image = { width: 1280, height: 720 };
  const rect = { x: 0, y: 0, ...image };
  expect(adjustCrop(rect, "ArrowLeft", false, image)).toEqual(rect);
  expect(adjustCrop(rect, "ArrowDown", false, image)).toEqual(rect);
  expect(adjustCrop(rect, "ArrowRight", true, image)).toEqual(rect);
  expect(adjustCrop({ x: 0, y: 0, width: 1, height: 1 }, "ArrowLeft", true, image).width).toBe(1);
});
it("encodes a cropped canvas rather than attaching the original image with a visual mask", () => {
  const image = Object.assign(document.createElement("img"), { src: "data:image/png;base64,b3JpZ2luYWw=" });
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 1280 }, naturalHeight: { value: 720 } });
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
    expect([this.width, this.height]).toEqual([640, 360]); return "data:image/png;base64,Y3JvcA==";
  });
  expect(cropScreenshot(image, { x: 320, y: 180, width: 640, height: 360 })).toEqual({ dataUrl: "data:image/png;base64,Y3JvcA==", width: 640, height: 360 });
  expect(draw).toHaveBeenCalledWith(image, 320, 180, 640, 360, 0, 0, 640, 360);
});
it("rejects unavailable pixels and invalid bounds before drawing or falling back to the full image", () => {
  const image = document.createElement("img");
  const draw = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  expect(() => cropScreenshot(image, { x: 0, y: 0, width: 1, height: 1 })).toThrow();
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
  for (const rect of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 101, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }]) {
    expect(() => cropScreenshot(image, rect)).toThrow();
  }
  expect(draw).not.toHaveBeenCalled();
});

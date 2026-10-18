import type { Screenshot } from "./screen-capture";

export interface CropPoint { x: number; y: number }
export interface CropRect extends CropPoint { width: number; height: number }

export function cropPoint(clientX: number, clientY: number, display: Pick<DOMRect, "left" | "top" | "width" | "height">, image: Pick<Screenshot, "width" | "height">): CropPoint {
  return {
    x: Math.max(0, Math.min(image.width, Math.round((clientX - display.left) / display.width * image.width))),
    y: Math.max(0, Math.min(image.height, Math.round((clientY - display.top) / display.height * image.height))),
  };
}

export function cropRectangle(start: CropPoint, end: CropPoint): CropRect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export function adjustCrop(rect: CropRect, key: string, resize: boolean, image: Pick<Screenshot, "width" | "height">): CropRect {
  const dx = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  const dy = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
  return resize ? { ...rect,
    width: Math.max(1, Math.min(image.width - rect.x, rect.width + dx)),
    height: Math.max(1, Math.min(image.height - rect.y, rect.height + dy)),
  } : { ...rect,
    x: Math.max(0, Math.min(image.width - rect.width, rect.x + dx)),
    y: Math.max(0, Math.min(image.height - rect.height, rect.y + dy)),
  };
}

/** Encode only the selected source pixels. No CSS mask or full-image attachment. */
export function cropScreenshot(image: HTMLImageElement, rect: CropRect): Screenshot {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight ||
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) ||
      rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 ||
      rect.x + rect.width > image.naturalWidth || rect.y + rect.height > image.naturalHeight) {
    throw new Error("Invalid crop bounds or unloaded image");
  }
  const canvas = document.createElement("canvas");
  canvas.width = rect.width; canvas.height = rect.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  const dataUrl = canvas.toDataURL("image/png");
  if (!dataUrl.startsWith("data:image/png;base64,") || dataUrl.length > 12 * 1024 * 1024) throw new Error("Invalid crop image");
  return { dataUrl, width: rect.width, height: rect.height };
}

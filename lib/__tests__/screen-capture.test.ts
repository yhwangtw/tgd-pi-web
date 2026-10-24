// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureScreenshot, screenCaptureSupport } from "../screen-capture";

const png = "data:image/png;base64,cGl4ZWxz";
let track: MediaStreamTrack;
let stream: MediaStream;
let getDisplayMedia: ReturnType<typeof vi.fn>;
let frame: (() => void) | undefined;
let ready = 2;
let play: ReturnType<typeof vi.spyOn>;
const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
const originalSecure = Object.getOwnPropertyDescriptor(window, "isSecureContext");

beforeEach(() => {
  frame = undefined; ready = 2;
  track = Object.assign(new EventTarget(), { stop: vi.fn(), readyState: "live" }) as unknown as MediaStreamTrack;
  stream = { getTracks: () => [track], getVideoTracks: () => [track] } as MediaStream;
  getDisplayMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia } });
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(() => ready);
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(4000);
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(2000);
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", { configurable: true, value: (fn: () => void) => { frame = fn; return 1; } });
  Object.defineProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
    expect(track.stop).toHaveBeenCalled(); // sharing ends before encoding
    return png;
  });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
  if (originalMedia) Object.defineProperty(navigator, "mediaDevices", originalMedia); else Reflect.deleteProperty(navigator, "mediaDevices");
  if (originalSecure) Object.defineProperty(window, "isSecureContext", originalSecure); else Reflect.deleteProperty(window, "isSecureContext");
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("one-frame screen capture", () => {
  it("requests from the click stack, waits for decoded pixels, scales and stops before returning", async () => {
    const result = captureScreenshot(new AbortController().signal);
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ video: true, audio: false }));
    await flush();
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
    frame!();
    await expect(result).resolves.toEqual({ dataUrl: png, width: 2560, height: 1280 });
    expect(document.querySelector("video")).toBeNull();
  });
  it("stops a late permission result after cancellation without capturing", async () => {
    let grant!: (source: MediaStream) => void;
    getDisplayMedia.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    const controller = new AbortController(); const result = captureScreenshot(controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    grant(stream); await flush();
    expect(track.stop).toHaveBeenCalled();
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
  });
  it("captures decoded loadeddata when a compositor frame callback is deferred", async () => {
    ready = 0;
    const result = captureScreenshot(new AbortController().signal); await flush();
    const video = document.querySelector("video")!;
    ready = 1; video.dispatchEvent(new Event("loadeddata"));
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
    ready = 2; video.dispatchEvent(new Event("loadeddata"));
    await expect(result).resolves.toEqual({ dataUrl: png, width: 2560, height: 1280 });
    expect(HTMLVideoElement.prototype.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    frame!();
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
    expect(document.querySelector("video")).toBeNull();
  });
  it.each(["abort", "ended"])("cleans up when %s arrives before a frame", async mode => {
    const controller = new AbortController(); const result = captureScreenshot(controller.signal);
    await flush();
    if (mode === "abort") controller.abort(); else track.dispatchEvent(new Event("ended"));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(track.stop).toHaveBeenCalled(); expect(document.querySelector("video")).toBeNull();
  });
  it("times out a stalled stream and releases every track", async () => {
    vi.useFakeTimers();
    const result = captureScreenshot(new AbortController().signal);
    const check = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await flush(); await vi.advanceTimersByTimeAsync(10_000); await check;
    expect(track.stop).toHaveBeenCalled(); expect(document.querySelector("video")).toBeNull();
  });
  it("supports browsers without video-frame callbacks", async () => {
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
    ready = 0;
    const result = captureScreenshot(new AbortController().signal); await flush();
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
    ready = 2; document.querySelector("video")!.dispatchEvent(new Event("loadeddata"));
    await expect(result).resolves.toMatchObject({ dataUrl: png });
  });
  it("releases sharing when playback or encoding fails", async () => {
    play.mockRejectedValue(new Error("playback failed"));
    await expect(captureScreenshot(new AbortController().signal)).rejects.toMatchObject({ name: "NotReadableError" });
    expect(track.stop).toHaveBeenCalled();
    play.mockResolvedValue(undefined);
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(() => { throw new Error("encoding failed"); });
    const result = captureScreenshot(new AbortController().signal); await flush(); frame!();
    await expect(result).rejects.toThrow("encoding failed");
    expect(document.querySelector("video")).toBeNull();
  });
  it("does not invoke capture when cancelled or unsupported", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(captureScreenshot(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
    expect(screenCaptureSupport()).toBe("unsupported");
    await expect(captureScreenshot(new AbortController().signal)).rejects.toMatchObject({ name: "NotSupportedError" });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    expect(screenCaptureSupport()).toBe("insecure"); expect(getDisplayMedia).not.toHaveBeenCalled();
  });
});

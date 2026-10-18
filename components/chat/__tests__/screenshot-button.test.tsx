// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScreenshotButton } from "../ScreenshotButton";
import { ChatInput, type ChatInputHandle } from "../ChatInput";
import { captureScreenshot, screenCaptureSupport, type Screenshot } from "@/lib/screen-capture";
import { setLocale } from "@/lib/i18n";
import { showToast } from "@/hooks/useToast";

vi.mock("@/lib/screen-capture", () => ({ captureScreenshot: vi.fn(), screenCaptureSupport: vi.fn(() => "supported") }));
vi.mock("@/hooks/useToast", () => ({ showToast: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const screenshot: Screenshot = { dataUrl: "data:image/png;base64,c2NyZWVu", width: 1280, height: 720 };
let root: Root; let host: HTMLDivElement;
const attached = vi.fn(); const choose = vi.fn();
const props = { className: "capture-button", disabled: false, onAttach: attached, onChooseFile: choose };
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === name || b.textContent === name)!;
const click = async (name: string) => { await act(async () => button(name).click()); };
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
beforeEach(() => {
  vi.clearAllMocks(); setLocale("en");
  vi.mocked(captureScreenshot).mockResolvedValue(screenshot);
  vi.mocked(screenCaptureSupport).mockReturnValue("supported");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ prompts: [] }) }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  URL.revokeObjectURL = vi.fn();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); setLocale("en"); });

it("previews locally and attaches only after confirmation", async () => {
  await render(<ScreenshotButton {...props} />); await click("Take screenshot");
  expect(document.querySelector<HTMLImageElement>('[alt="Screenshot preview"]')!.src).toBe(screenshot.dataUrl);
  expect(attached).not.toHaveBeenCalled();
  await click("Attach screenshot");
  expect(attached).toHaveBeenCalledExactlyOnceWith(screenshot);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("cancel and Escape discard the preview; retake makes a fresh capture", async () => {
  await render(<ScreenshotButton {...props} />); await click("Take screenshot"); await click("Cancel");
  expect(attached).not.toHaveBeenCalled();
  await click("Take screenshot"); await click("Retake");
  expect(captureScreenshot).toHaveBeenCalledTimes(3);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(attached).not.toHaveBeenCalled();
});
it("aborts pending capture on a second click and discards its late result", async () => {
  let resolve!: (value: Screenshot) => void;
  vi.mocked(captureScreenshot).mockImplementation(() => new Promise(done => { resolve = done; }));
  await render(<ScreenshotButton {...props} />); await click("Take screenshot");
  const signal = vi.mocked(captureScreenshot).mock.calls[0][0];
  await click("Cancel screenshot"); expect(signal.aborted).toBe(true);
  await act(async () => resolve(screenshot));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(captureScreenshot).toHaveBeenCalledOnce();
});
it("aborts a source picker when switching conversation and ignores late pixels", async () => {
  let resolve!: (value: Screenshot) => void;
  vi.mocked(captureScreenshot).mockImplementation(() => new Promise(done => { resolve = done; }));
  await render(<ScreenshotButton {...props} key="one" />); await click("Take screenshot");
  const signal = vi.mocked(captureScreenshot).mock.calls[0][0];
  await render(<ScreenshotButton {...props} key="two" />); expect(signal.aborted).toBe(true);
  await act(async () => resolve(screenshot));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(attached).not.toHaveBeenCalled();
});
it.each(["unsupported", "insecure"] as const)("offers system screenshots and file selection when %s", async support => {
  vi.mocked(screenCaptureSupport).mockReturnValue(support);
  await render(<ScreenshotButton {...props} />); await click("Take screenshot");
  expect(document.body.textContent).toContain("Win + Shift + S"); expect(captureScreenshot).not.toHaveBeenCalled();
  await click("Choose an image"); expect(choose).toHaveBeenCalledOnce();
});
it("offers the fallback when an embedded browser exposes an unusable capture API", async () => {
  vi.mocked(captureScreenshot).mockRejectedValueOnce(new DOMException("unavailable", "NotSupportedError"));
  await render(<ScreenshotButton {...props} />); await click("Take screenshot");
  expect(document.body.textContent).toContain("does not support direct screen capture");
  await click("Choose an image"); expect(choose).toHaveBeenCalledOnce();
});
it("handles denied permission quietly and explains capture failures", async () => {
  await render(<ScreenshotButton {...props} />);
  vi.mocked(captureScreenshot).mockRejectedValueOnce(new DOMException("permission", "NotAllowedError"));
  await click("Take screenshot"); expect(showToast).toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')).toBeNull();
  vi.mocked(captureScreenshot).mockRejectedValueOnce(new Error("hardware"));
  await click("Take screenshot"); expect(document.body.textContent).toContain("system settings");
});
it("preserves the draft, sends the confirmed PNG and clears attachments on conversation changes", async () => {
  const ref = createRef<ChatInputHandle>(); const send = vi.fn().mockResolvedValue(false);
  await render(<ChatInput ref={ref} onSend={send} onAbort={vi.fn()} isStreaming={false} persistKey="one" />);
  await act(async () => ref.current!.setText("please inspect"));
  await click("Take screenshot"); expect(send).not.toHaveBeenCalled();
  await click("Attach screenshot"); expect(button("Remove image")).toBeTruthy(); expect(send).not.toHaveBeenCalled();
  await click("Send"); expect(send).toHaveBeenCalledWith("please inspect", [expect.objectContaining({ data: "c2NyZWVu", mimeType: "image/png" })]);
  expect(host.querySelector("textarea")!.value).toBe("please inspect"); // rejected sends retain the draft
  await render(<ChatInput ref={ref} onSend={send} onAbort={vi.fn()} isStreaming={false} persistKey="two" />);
  expect(button("Remove image")).toBeUndefined();
});

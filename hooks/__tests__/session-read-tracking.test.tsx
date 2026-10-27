// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mark = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session-read-state", () => ({ markSessionRead: mark }));
import { useSessionReadTracking, visibleReadCandidate } from "../use-session-read-tracking";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLDivElement, container: HTMLDivElement, message: HTMLDivElement;
let options: Parameters<typeof useSessionReadTracking>[0];
const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 600, width: 600, height: bottom - top, x: 0, y: top, toJSON() {} });
beforeEach(() => {
  vi.useFakeTimers(); mark.mockClear();
  host = document.createElement("div"); container = document.createElement("div"); message = document.createElement("div");
  document.body.append(host, container); container.append(message);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => message) });
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(100, 600));
  vi.spyOn(message, "getBoundingClientRect").mockReturnValue(rect(200, 400));
  options = { sessionId: "one", ready: true, streaming: false, containerRef: { current: container }, messageRefs: { current: [message] }, displayIndices: [0], entryIds: ["answer"], messages: [{ role: "assistant", content: [], model: "fixture", provider: "fixture", timestamp: 1000 }] };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host.remove(); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
function Harness({ value }: { value: typeof options }) { useSessionReadTracking(value); return null; }
async function render(value = options) { root ??= createRoot(host); await act(async () => root!.render(<Harness value={value} />)); }
it("requires a full foreground dwell and never saves on fast navigation/cleanup", async () => {
  await render(); await act(async () => vi.advanceTimersByTime(400)); expect(mark).not.toHaveBeenCalled();
  await render({ ...options, sessionId: "two" });
  await act(async () => vi.advanceTimersByTime(400)); expect(mark).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(200));
  expect(mark).toHaveBeenCalledExactlyOnceWith("two", 1000, "answer", ["answer"]);
});
it("requires a fresh dwell after scrolling, blur and visibility changes", async () => {
  await render(); await act(async () => vi.advanceTimersByTime(400));
  container.dispatchEvent(new Event("scroll"));
  await act(async () => vi.advanceTimersByTime(600)); expect(mark).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(200)); expect(mark).toHaveBeenCalledOnce();
});
it("ignores out-of-view content, overlays, unfocused tabs, and an unfinished answer", () => {
  vi.mocked(message.getBoundingClientRect).mockReturnValue(rect(-100, 90)); expect(visibleReadCandidate(options)).toBeNull();
  vi.mocked(message.getBoundingClientRect).mockReturnValue(rect(400, 700)); expect(visibleReadCandidate(options)).toBeNull();
  vi.mocked(message.getBoundingClientRect).mockReturnValue(rect(200, 400));
  vi.mocked(document.elementFromPoint).mockReturnValue(host); expect(visibleReadCandidate(options)).toBeNull();
  vi.mocked(document.elementFromPoint).mockReturnValue(message);
  vi.mocked(document.hasFocus).mockReturnValue(false); expect(visibleReadCandidate(options)).toBeNull();
  vi.mocked(document.hasFocus).mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); expect(visibleReadCandidate(options)).toBeNull();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  expect(visibleReadCandidate({ ...options, streaming: true })).toBeNull();
  expect(visibleReadCandidate(options)?.entryId).toBe("answer");
});
it("blocks visible modal dialogs and allows the visible bottom of a long message", () => {
  vi.mocked(message.getBoundingClientRect).mockReturnValue(rect(-400, 400));
  expect(visibleReadCandidate(options)?.entryId).toBe("answer");
  host.setAttribute("aria-modal", "true");
  vi.spyOn(host, "getClientRects").mockReturnValue([rect(0, 600)] as unknown as DOMRectList);
  expect(visibleReadCandidate(options)).toBeNull();
});
it("does not measure or mark until read hydration and the transcript are ready", async () => {
  await render({ ...options, ready: false });
  await act(async () => vi.advanceTimersByTime(2000)); expect(mark).not.toHaveBeenCalled();
});

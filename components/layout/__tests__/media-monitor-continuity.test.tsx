// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { VideoViewer } from "../VideoViewer";

vi.mock("@/lib/i18n", () => { const t = (key: string) => key; return { useI18n: () => ({ t }) }; });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("keeps the same video and playback position after reopening an unchanged preview", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ revision: "unchanged", size: 128 }) }));
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(<VideoViewer filePath="/fixture/movie.mp4" />));
    const video = host.querySelector("video")!;
    video.currentTime = 37;
    await act(async () => root.render(<VideoViewer filePath="/fixture/movie.mp4" visible={false} />));
    await act(async () => root.render(<VideoViewer filePath="/fixture/movie.mp4" />));
    await act(async () => vi.advanceTimersByTimeAsync(1_100));
    expect(host.querySelector("video")).toBe(video);
    expect(video.currentTime).toBe(37);
    expect(video.getAttribute("src")).not.toContain("&v=");
  } finally { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});

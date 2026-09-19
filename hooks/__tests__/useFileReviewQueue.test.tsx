// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileReviewQueue } from "../useFileReviewQueue";
import { useFileTabs } from "../useFileTabs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("passive file review queue", () => {
  let root: Root;
  let container: HTMLDivElement;
  let api: ReturnType<typeof useFileReviewQueue> & ReturnType<typeof useFileTabs>;
  const fetchMock = vi.fn();
  const response = (paths: string[]) => ({ ok: true, json: async () => ({ files: paths.map(path => ({ path })) }) });
  function Harness({ cwd = "/project", sessionId = "a" }) {
    const review = useFileReviewQueue(cwd, sessionId);
    const files = useFileTabs();
    useEffect(() => { api = { ...review, ...files }; });
    return null;
  }
  async function mount(cwd = "/project", sessionId = "a") {
    await act(async () => root.render(<Harness cwd={cwd} sessionId={sessionId} />));
  }
  async function refresh() {
    await act(async () => api.refreshReviewFiles());
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
  }
  beforeEach(() => {
    vi.useFakeTimers(); localStorage.clear(); fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div"); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("updates only the count after repeated completions, preserving the active file and its scroll", async () => {
    fetchMock.mockResolvedValue(response(["first.ts", "second.ts"]));
    await mount();
    await act(async () => api.handleOpenFile("/project/reading.md", "reading.md"));
    await act(async () => api.handleUpdateViewState("file:/project/reading.md", { scrollTop: 640, selection: null }));
    const before = api.fileTabs;
    await refresh(); await refresh();
    expect(api.pendingReviewFiles).toEqual(["first.ts", "second.ts"]);
    expect(api.activeFileTabId).toBe("file:/project/reading.md");
    expect(api.fileTabs).toBe(before);
    await act(async () => api.setRightPanelOpen(false));
    await refresh();
    expect(api.rightPanelOpen).toBe(false);
    expect(api.fileTabs).toBe(before);
    await act(async () => api.markReviewed("first.ts"));
    expect(api.pendingReviewFiles).toEqual(["second.ts"]);
  });

  it("cancels a delayed refresh when switching conversations in the same project", async () => {
    await mount();
    await act(async () => api.refreshReviewFiles());
    await mount("/project", "b");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.pendingReviewFiles).toEqual([]);
  });

  it("ignores an in-flight response after switching away and back", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await mount(); await refresh();
    const signal = fetchMock.mock.calls[0][1].signal;
    await mount("/other", "b"); await mount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(response(["stale.ts"])));
    expect(api.pendingReviewFiles).toEqual([]);
    expect(api.fileTabs).toEqual([]);
    expect(api.rightPanelOpen).toBe(false);
  });

  it("clears prior-session review counts and accepts only the latest refresh", async () => {
    fetchMock.mockResolvedValueOnce(response(["old.ts"]));
    await mount(); await refresh();
    expect(api.pendingReviewFiles).toEqual(["old.ts"]);
    await mount("/project", "b");
    expect(api.pendingReviewFiles).toEqual([]);
    let resolve!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await refresh();
    fetchMock.mockResolvedValueOnce(response(["new.ts", "new.ts"]));
    await refresh();
    await act(async () => resolve(response(["stale.ts"])));
    expect(api.pendingReviewFiles).toEqual(["new.ts"]);
  });

  it("aborts on unmount and keeps failures quiet", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await mount(); await refresh();
    expect(api.pendingReviewFiles).toEqual([]);
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    await refresh();
    const signal = fetchMock.mock.calls[1][1].signal;
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(signal.aborted).toBe(true);
  });
});

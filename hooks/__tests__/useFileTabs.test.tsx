// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFileTabs } from "../useFileTabs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FileTabsApi = ReturnType<typeof useFileTabs>;

describe("useFileTabs", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let api: FileTabsApi | null = null;

  function Harness() {
    const nextApi = useFileTabs();
    useEffect(() => {
      api = nextApi;
    }, [nextApi]);
    return null;
  }

  beforeEach(() => localStorage.clear());

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    api = null;
  });

  it.each([true, false])("restores panel visibility (%s) without losing tabs or reading position", async (open) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    await act(async () => api?.handleOpenFile("/workspace/notes.md", "notes.md"));
    await act(async () => api?.handleUpdateViewState("file:/workspace/notes.md", { scrollTop: 640, selection: null }));
    await act(async () => api?.setRightPanelOpen(open));
    await act(async () => root?.unmount());
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    expect(api?.rightPanelOpen).toBe(open);
    expect(api?.activeFileTabId).toBe("file:/workspace/notes.md");
    expect(api?.fileTabs[0].viewState?.scrollTop).toBe(640);
  });

  it("keeps legacy saved tabs without reopening the panel uninvited", async () => {
    localStorage.setItem("pi-file-workspace-v1", JSON.stringify({ tabs: [{ id: "file:/a.md", filePath: "/a.md", label: "a.md" }], active: "file:/a.md" }));
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    expect(api?.fileTabs).toHaveLength(1);
    expect(api?.rightPanelOpen).toBe(false);
    await act(async () => api?.handleOpenFile("/a.md", "a.md"));
    expect(api?.rightPanelOpen).toBe(true);
  });

  it("keeps one canonical open intent and per-tab reading state", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));

    await act(async () => api?.handleOpenFile({
      path: "/workspace/src/index.ts",
      label: "index.ts",
      line: 42,
      mode: "source",
      origin: { kind: "search", query: "render" },
    }));

    expect(api?.fileTabs).toHaveLength(1);
    expect(api?.fileTabs[0].intent).toMatchObject({
      path: "/workspace/src/index.ts",
      line: 42,
      mode: "source",
      origin: { kind: "search", query: "render" },
    });

    await act(async () => api?.handleConsumeNavigation("file:/workspace/src/index.ts"));
    expect(api?.fileTabs[0].gotoLine).toBeUndefined();
    expect(api?.fileTabs[0].intent?.line).toBe(42);

    await act(async () => api?.handleUpdateViewState("file:/workspace/src/index.ts", {
      scrollTop: 640,
      selection: { startLine: 40, endLine: 42, text: "selected" },
    }));

    expect(api?.fileTabs[0].viewState).toEqual({
      scrollTop: 640,
      selection: { startLine: 40, endLine: 42, text: "selected" },
    });

    await act(async () => api?.handleOpenFile({
      path: "/workspace/src/index.ts",
      label: "index.ts",
      mode: "auto",
      origin: { kind: "message", entryId: "entry-1", sessionId: "session-1" },
    }));

    expect(api?.fileTabs).toHaveLength(1);
    expect(api?.fileTabs[0].intent?.origin).toEqual({ kind: "message", entryId: "entry-1", sessionId: "session-1" });
    expect(api?.fileTabs[0].viewState?.scrollTop).toBe(640);
  });
});

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

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { FileInspectorDrawer } from "../FileInspectorDrawer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());
const base = { filePath: "/fixture/sample.ts", relativePath: "sample.ts", cwd: "/fixture", outline: [], onClose: () => {}, onGotoLine: () => {}, onCompareVersion: () => {} };

it("carries the current session for diagnostics and tests while retaining history and blame requests", async () => {
  const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ diagnostics: [], commits: [], snapshots: [], lines: [] })));
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); const root = createRoot(host);
  const params = () => fetcher.mock.calls.map(([url]) => new URL(String(url), "http://fixture"));
  try {
    await act(async () => root.render(<FileInspectorDrawer {...base} sessionId="dw_fixture" initialTab="problems" />));
    expect(params()[0].searchParams.get("mode")).toBe("diagnostics");
    expect(params()[0].searchParams.get("sessionId")).toBe("dw_fixture");
    const runTests = [...host.querySelectorAll("button")].find((button) => button.textContent === "Run related tests")!;
    await act(async () => runTests.click());
    const testRequest = params().find((url) => url.searchParams.get("mode") === "tests")!;
    expect(testRequest.searchParams.get("sessionId")).toBe("dw_fixture");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "History")!.click());
    const history = params().find((url) => url.searchParams.get("mode") === "history")!;
    expect(history.searchParams.has("sessionId")).toBe(false);
    expect(params().find((url) => url.pathname === "/api/git/snapshots")?.searchParams.get("sessionId")).toBe("dw_fixture");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "Blame")!.click());
    expect(params().find((url) => url.searchParams.get("mode") === "blame")!.searchParams.has("sessionId")).toBe(false);
  } finally { await act(async () => root.unmount()); }
});

it("shows the existing server authorization error when no session is available", async () => {
  const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ error: "An active trusted session is required" }), { status: 403 }));
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(<FileInspectorDrawer {...base} initialTab="problems" />));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("An active trusted session is required");
    expect(new URL(String(fetcher.mock.calls[0][0]), "http://fixture").searchParams.has("sessionId")).toBe(false);
  } finally { await act(async () => root.unmount()); }
});

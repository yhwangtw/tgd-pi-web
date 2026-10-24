// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DocumentViewer } from "../DocumentViewer";

const watch = vi.hoisted(() => ({ watching: true, refreshTrigger: 0 }));
vi.mock("@/hooks/useFileWatch", () => ({ useFileWatch: () => watch }));
vi.mock("@/lib/i18n", () => { const t = (key: string) => key; return { useI18n: () => ({ t }) }; });
vi.mock("../FileViewer", () => ({ DownloadLink: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); root = createRoot(host); watch.refreshTrigger = 0; });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it("refreshes document metadata and preview together when the monitor observes a change", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ size: 128 }) });
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<DocumentViewer filePath="/project/a.pdf" />));
  expect(host.querySelector("iframe")?.getAttribute("src")).toContain("type=read");
  watch.refreshTrigger = 1;
  await act(async () => root.render(<DocumentViewer filePath="/project/a.pdf" />));
  expect(host.querySelector("iframe")?.getAttribute("src")).toContain("&v=1");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("aborts stale metadata and never replaces a new document with the old path's error", async () => {
  let finish!: (value: unknown) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ ok: true, json: async () => ({ size: 64 }) });
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<DocumentViewer filePath="/project/old.docx" />));
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  await act(async () => root.render(<DocumentViewer filePath="/project/new.pdf" />));
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ ok: false, status: 404, json: async () => ({ error: "old missing document" }) }));
  expect(host.textContent).not.toContain("old missing document");
  expect(host.querySelector("iframe")?.getAttribute("src")).toContain("new.pdf");
});

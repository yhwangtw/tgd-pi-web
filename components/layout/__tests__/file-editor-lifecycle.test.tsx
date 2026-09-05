// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextFileViewer } from "../TextFileViewer";

const watch = vi.hoisted(() => ({ refresh: 0 }));
vi.mock("@/hooks/useFileWatch", () => ({ useFileWatch: () => ({ watching: true, refreshTrigger: watch.refresh }) }));
vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/useToast", () => ({ showToast: vi.fn() }));
vi.mock("../text-viewer/SourceView", () => ({ SourceView: ({ content }: { content: string }) => <pre data-source>{content}</pre> }));
vi.mock("../text-viewer/PlainSourceView", () => ({ PlainSourceView: ({ content }: { content: string }) => <pre data-source>{content}</pre> }));
vi.mock("../text-viewer/DiffViewMode", () => ({ DiffViewMode: () => null }));
vi.mock("../FileInspectorDrawer", () => ({ FileInspectorDrawer: () => null }));
// Menu interaction has separate real-browser coverage; these tests isolate the
// viewer's async ownership and draft lifetime, not Radix positioning.
vi.mock("@/components/ui/ActionMenu", () => ({
  ActionMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ActionMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = (content: string, revision = "a") => ({ content, language: "text", size: content.length, version: revision.repeat(64) });
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("file editor request ownership", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn<typeof fetch>();
  const render = (name: string, gotoNonce?: number, initialMode: "auto" | "source" | "preview" = "auto") => act(async () => { root.render(<TextFileViewer filePath={`/project/${name}.txt`} gotoNonce={gotoNonce} initialMode={initialMode} />); });
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(el => el.textContent === label)!;
    expect(button, label).toBeTruthy();
    await act(async () => button.click());
  };
  const edit = async (text: string) => {
    await click("files.editFile");
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    watch.refresh = 0;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts and ignores an old file read even if the transport resolves after abort", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation(async url => String(url).includes("/a.txt") ? pending.promise : response(file("file B", "b")));
    await render("a");
    const firstSignal = fetchMock.mock.calls[0][1]!.signal!;
    await render("b");
    expect(firstSignal.aborted).toBe(true);
    await act(async () => pending.resolve(response(file("late A"))));
    expect(container.querySelector("[data-source]")?.textContent).toBe("file B");
  });

  it("deduplicates save clicks and ignores a save response after a file switch", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation(async (url, options) => options?.method === "PUT" ? pending.promise : response(file(String(url).includes("/a.txt") ? "file A" : "file B")));
    await render("a");
    await edit("my draft");
    await click("files.save");
    await click("files.saving");
    const saves = fetchMock.mock.calls.filter(([, options]) => options?.method === "PUT");
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0][1]!.body as string)).toEqual({ content: "my draft", expectedVersion: "a".repeat(64) });
    await render("b");
    expect(saves[0][1]!.signal!.aborted).toBe(true);
    await act(async () => pending.resolve(response({ ...file("saved A", "b"), success: true })));
    expect(container.querySelector("[data-source]")?.textContent).toBe("file B");
  });

  it("does not apply a watch refresh after editing starts", async () => {
    const pending = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response(file("original"))).mockImplementation(() => pending.promise);
    await render("a");
    watch.refresh = 1;
    await render("a");
    await act(async () => vi.advanceTimersByTime(300));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await edit("keep draft");
    await act(async () => pending.resolve(response(file("external", "b"))));
    expect(container.querySelector("textarea")?.value).toBe("keep draft");
  });

  it("keeps an open draft when the same tab receives a navigation nonce", async () => {
    fetchMock.mockResolvedValue(response(file("original")));
    await render("a", 1);
    await edit("keep draft");
    await render("a", 2);
    expect(container.querySelector("textarea")?.value).toBe("keep draft");
  });

  it("keeps save available when a preview request arrives during editing", async () => {
    fetchMock.mockResolvedValue(response({ ...file("original"), language: "html" }));
    await render("a", 1, "source");
    await edit("keep HTML draft");
    await render("a", 1, "preview");
    expect(container.querySelector("textarea")?.value).toBe("keep HTML draft");
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "files.save")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft on save failure and retries the original revision", async () => {
    fetchMock.mockResolvedValueOnce(response(file("original")))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "disk unavailable" }), { status: 500 }))
      .mockResolvedValueOnce(response({ ...file("my draft", "b"), success: true }));
    await render("a");
    await edit("my draft");
    await click("files.save");
    expect(container.querySelector("textarea")?.value).toBe("my draft");
    expect(container.textContent).toContain("disk unavailable");
    await click("files.save");
    const saves = fetchMock.mock.calls.filter(([, options]) => options?.method === "PUT");
    expect(saves).toHaveLength(2);
    for (const [, options] of saves) expect(JSON.parse(options!.body as string)).toEqual({ content: "my draft", expectedVersion: "a".repeat(64) });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("[data-source]")?.textContent).toBe("my draft");
  });
});

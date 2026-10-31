// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HtmlPreview } from "../text-viewer/HtmlPreview";
import { PreviewView } from "../text-viewer/PreviewView";
import { setLocale } from "@/lib/i18n";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("HTML preview lifecycle", () => {
  let root: Root;
  let host: HTMLDivElement;
  const fetchMock = vi.fn();
  beforeEach(() => {
    setLocale("en");
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  const response = (html: string) => new Response(JSON.stringify({ html, warnings: [] }));
  it("waits for the iframe load and refetches a changed revision", async () => {
    const rendered = vi.fn();
    // jsdom fires a synthetic about:blank load immediately. Hold it so the
    // assertion can distinguish a mounted iframe from its load completion.
    const holdLoad = (event: Event) => { if (event.target instanceof HTMLIFrameElement) event.stopImmediatePropagation(); };
    host.addEventListener("load", holdLoad, true);
    fetchMock.mockResolvedValue(response("<h1>Before</h1>"));
    await act(async () => root.render(<HtmlPreview content="Before" filePath="/project/index.html" revision="1" onRendered={rendered} />));
    expect(rendered).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Rendering preview");
    expect(host.querySelector("button")!.textContent).toBe("Reload preview");
    host.removeEventListener("load", holdLoad, true);
    await act(async () => host.querySelector("iframe")!.dispatchEvent(new Event("load")));
    expect(rendered).toHaveBeenCalledOnce();
    expect(host.querySelector('[aria-busy="false"]')).not.toBeNull();
    fetchMock.mockResolvedValue(response("<h1>After</h1>"));
    await act(async () => root.render(<HtmlPreview content="After" filePath="/project/index.html" revision="2" onRendered={rendered} />));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.querySelector("iframe")!.srcdoc).toContain("After");
    expect(host.querySelector("iframe")!.getAttribute("sandbox")).toBe("allow-scripts");
  });
  it("lets the parent reload a rendered HTML preview without an embedded toolbar", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(response("<h1>Same content</h1>")));
    await act(async () => root.render(<PreviewView language="html" content="Same content" filePath="/project/index.html" revision="1" reloadKey={0} />));
    const previousFrame = host.querySelector("iframe")!;
    expect(host.querySelector("button")).toBeNull();
    await act(async () => root.render(<PreviewView language="html" content="Same content" filePath="/project/index.html" revision="1" reloadKey={1} />));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.querySelector("iframe")).not.toBe(previousFrame);
    expect(host.querySelector("iframe")!.srcdoc).toContain("Same content");
    expect(host.querySelector("button")).toBeNull();
  });
  it("aborts an in-flight request when the parent reloads the same file", async () => {
    let resolvePrevious!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePrevious = resolve; }));
    fetchMock.mockResolvedValueOnce(response("<h1>Reloaded content</h1>"));
    await act(async () => root.render(<HtmlPreview content="" filePath="/project/index.html" reloadKey={0} showToolbar={false} />));
    const previousSignal = fetchMock.mock.calls[0][1].signal;
    expect(host.querySelector('[role="status"]')!.textContent).toContain("Rendering preview");
    expect(host.querySelector("button")).toBeNull();
    await act(async () => root.render(<HtmlPreview content="" filePath="/project/index.html" reloadKey={1} showToolbar={false} />));
    expect(previousSignal.aborted).toBe(true);
    await act(async () => resolvePrevious(response("<h1>Stale content</h1>")));
    expect(host.querySelector("iframe")!.srcdoc).toContain("Reloaded content");
    expect(host.querySelector("iframe")!.srcdoc).not.toContain("Stale content");
  });
  it("reports a missing file and lets retry recover", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    await act(async () => root.render(<HtmlPreview content="" filePath="/project/index.html" revision="1" />));
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("moved or deleted");
    fetchMock.mockResolvedValue(response("<h1>Restored</h1>"));
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector("iframe")!.srcdoc).toContain("Restored");
  });
  it("keeps retry in embedded error feedback and removes it after recovery", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));
    await act(async () => root.render(<HtmlPreview content="" filePath="/project/index.html" showToolbar={false} />));
    const feedback = host.querySelector('[role="alert"]')!;
    expect(feedback.textContent).toContain("outside the accessible project");
    expect(feedback.querySelector("button")!.textContent).toBe("Retry preview");
    expect(host.querySelectorAll("button")).toHaveLength(1);
    fetchMock.mockResolvedValue(response("<h1>Recovered</h1>"));
    await act(async () => feedback.querySelector("button")!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("iframe")!.srcdoc).toContain("Recovered");
  });
  it("ignores a slow response from a previously selected file", async () => {
    let resolveOld!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }));
    fetchMock.mockResolvedValueOnce(response("<h1>New file</h1>"));
    await act(async () => root.render(<HtmlPreview content="" filePath="/project/old.html" />));
    const oldSignal = fetchMock.mock.calls[0][1].signal;
    await act(async () => root.render(<HtmlPreview content="" filePath="/project/new.html" />));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolveOld(response("<h1>Old file</h1>")));
    expect(host.querySelector("iframe")!.srcdoc).toContain("New file");
    expect(host.querySelector("iframe")!.srcdoc).not.toContain("Old file");
  });
  it("stops waiting on a stalled request and offers retry", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await act(async () => root.render(<HtmlPreview content="" filePath="/project/index.html" showToolbar={false} />));
    await act(async () => vi.advanceTimersByTime(15000));
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("timed out");
    expect(host.querySelector('[role="alert"] button')!.textContent).toBe("Retry preview");
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

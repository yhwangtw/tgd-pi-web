// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewView } from "../text-viewer/PreviewView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Markdown file preview", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("renders common README HTML while removing active content", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <PreviewView
        language="markdown"
        filePath="/workspace/project/README.md"
        content={'<p align="center"><a href="https://example.com"><img src="https://example.com/badge.svg" alt="badge"></a></p><script>alert(1)</script>'}
      />,
    ));

    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container?.querySelector("p")?.getAttribute("align")).toBe("center");
    });
    const paragraph = container.querySelector("p");
    const image = container.querySelector("img");
    expect(paragraph?.getAttribute("align")).toBe("center");
    expect(image?.getAttribute("alt")).toBe("badge");
    expect(image?.getAttribute("loading")).toBe("lazy");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("<p align");
    expect(container.textContent).not.toContain("alert(1)");
  });

  it("resolves relative Markdown images through the guarded file API", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <PreviewView
        language="markdown"
        filePath="/workspace/project/docs/guide.md"
        content={'![Preview](../screenshots/mobile%20view.png)'}
      />,
    ));

    expect(container.querySelector("img")?.getAttribute("src"))
      .toBe("/api/files/workspace/project/screenshots/mobile%20view.png?type=raw");
  });

  it("maps repeated and formatted headings to their exact source lines", async () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(<PreviewView language="markdown" filePath="/project/README.md" content={"# **Same**\n\nText\n\n## Same\n\nSetext\n------\n\n```md\n# Example\n```"} />));
    expect([...container.querySelectorAll("[data-source-line]")].map((node) => [node.textContent, node.getAttribute("data-source-line")]))
      .toEqual([["Same", "1"], ["Same", "5"], ["Setext", "7"]]);
  });

  it("keeps inline HTML network-isolated as well as sandboxed", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<PreviewView language="html" content="<h1>Demo</h1>" />));
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.srcdoc).toContain("connect-src 'none'");
    expect(frame.srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(frame.srcdoc.indexOf("<h1>"));
    expect(frame.srcdoc).not.toContain("allow-same-origin");
  });
});

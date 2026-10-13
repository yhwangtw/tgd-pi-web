// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextFileViewer } from "../TextFileViewer";

vi.mock("@/hooks/useFileWatch", () => ({ useFileWatch: () => ({ watching: true, refreshTrigger: 0 }) }));
vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/useToast", () => ({ showToast: vi.fn() }));
vi.mock("../text-viewer/SourceView", () => ({ SourceView: () => <pre>source</pre> }));
vi.mock("../text-viewer/PlainSourceView", () => ({ PlainSourceView: () => <pre>source</pre> }));
vi.mock("../text-viewer/DiffViewMode", () => ({ DiffViewMode: () => null }));
vi.mock("../FileInspectorDrawer", () => ({
  FileInspectorDrawer: ({ onGotoLine, onClose }: { onGotoLine: (line: number) => void; onClose: () => void }) => <div data-testid="file-inspector"><button onClick={onClose}>Close Inspector</button><button onClick={() => onGotoLine(2)}>Jump to line</button></div>,
}));
vi.mock("@/components/ui/ActionMenu", () => ({
  ActionMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ActionMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("file viewer overlay ownership", () => {
  let container: HTMLDivElement;
  let root: Root;
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(node => node.textContent === label)!;
    expect(button).toBeTruthy();
    await act(async () => button.click());
  };
  const escape = async () => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => document.body.dispatchEvent(event));
    return event;
  };
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: "first\nsecond", language: "text", size: 12, version: "a".repeat(64) }))));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<TextFileViewer filePath="/project/a.txt" />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("closes Inspector before leaving file focus mode and restores its trigger focus", async () => {
    await click("files.focusMode");
    await click("files.inspector");
    expect((await escape()).defaultPrevented).toBe(true);
    expect(container.querySelector('[data-testid="file-inspector"]')).toBeNull();
    expect(container.querySelector('[data-file-focus-mode="true"]')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("files.inspector");
    await escape();
    expect(container.querySelector('[data-file-focus-mode="true"]')).toBeNull();
  });

  it("returns focus after explicit close and leaves the Inspector alone for keys outside its pane", async () => {
    await click("files.inspector");
    const otherPaneInput = document.createElement("input");
    document.body.append(otherPaneInput);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      otherPaneInput.focus();
      otherPaneInput.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector('[data-testid="file-inspector"]')).not.toBeNull();
    otherPaneInput.remove();
    await click("Close Inspector");
    expect(document.activeElement?.textContent).toBe("files.inspector");
  });

  it("closes an overlay after navigation but preserves a spacious inline Inspector", async () => {
    await click("files.inspector");
    const drawer = container.querySelector<HTMLElement>('[data-testid="file-inspector"]')!;
    drawer.style.position = "static";
    await click("Jump to line");
    expect(container.querySelector('[data-testid="file-inspector"]')).not.toBeNull();
    drawer.style.position = "absolute";
    await click("Jump to line");
    expect(container.querySelector('[data-testid="file-inspector"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="files.findLine"]')?.value).toBe(":2");
  });

  it("portals metadata out of the clipped viewer and dismisses it before Inspector", async () => {
    await click("files.inspector");
    const info = container.querySelector<HTMLDetailsElement>("details")!;
    await act(async () => {
      info.open = true;
      info.dispatchEvent(new Event("toggle"));
    });
    expect(container.querySelector('[role="region"][aria-label="files.info"]')).toBeNull();
    expect(document.body.querySelector('[role="region"][aria-label="files.info"]')).not.toBeNull();
    await escape();
    expect(info.open).toBe(false);
    expect(document.body.querySelector('[role="region"][aria-label="files.info"]')).toBeNull();
    expect(container.querySelector('[data-testid="file-inspector"]')).not.toBeNull();
  });


  it("does not reopen metadata after the file pane was hidden", async () => {
    const info = container.querySelector<HTMLDetailsElement>("details")!;
    await act(async () => { info.open = true; info.dispatchEvent(new Event("toggle")); });
    await act(async () => root.render(<TextFileViewer filePath="/project/a.txt" visible={false} />));
    await act(async () => root.render(<TextFileViewer filePath="/project/a.txt" />));
    expect(info.open).toBe(false);
    expect(document.body.querySelector('[role="region"][aria-label="files.info"]')).toBeNull();
  });
});

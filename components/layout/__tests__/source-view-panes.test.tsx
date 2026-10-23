// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SourceView } from "../text-viewer/SourceView";

vi.mock("react-syntax-highlighter", () => ({ PrismAsync: ({ children, lineProps }: { children: string; lineProps: (line: number) => object }) => <pre>{children.split("\n").map((line, index) => <span key={index} {...lineProps(index + 1)}>{line}</span>)}</pre> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("centers the active line within its own split preview pane", async () => {
  vi.useFakeTimers();
  const scrolled: HTMLElement[] = [];
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(<><section data-pane="first"><SourceView content={"first\nsecond"} language="text" wrapLines={false} activeLine={1} /></section><section data-pane="second"><SourceView content={"one\ntwo"} language="text" wrapLines={false} activeLine={2} /></section></>));
    await act(async () => vi.advanceTimersByTime(50));
    expect(scrolled.map((line) => line.closest("section")?.dataset.pane)).toEqual(["first", "second"]);
    expect(scrolled.map((line) => line.dataset.lineNumber)).toEqual(["1", "2"]);
  } finally { await act(async () => root.unmount()); HTMLElement.prototype.scrollIntoView = originalScroll; vi.useRealTimers(); }
});

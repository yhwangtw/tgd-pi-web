// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MarkdownBody } from "../MarkdownBody";

const fixture = vi.hoisted(() => ({ parses: 0 }));
vi.mock("remark-gfm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remark-gfm")>();
  return { default: function countedGfm(this: unknown, ...args: Parameters<typeof actual.default>) {
    fixture.parses++;
    return actual.default.apply(this as never, args);
  } };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("does not reparse unchanged Markdown when only streaming metadata or output accessories change", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const markdown = "# Result\n\nA **formatted** answer with [a link](https://example.com).";
  try {
    await act(async () => root.render(<MarkdownBody>{markdown}</MarkdownBody>));
    expect(fixture.parses).toBe(1);
    await act(async () => root.render(<MarkdownBody isStreaming outputAccessory={<span>Updated work log</span>}>{markdown}</MarkdownBody>));
    await act(async () => root.render(<MarkdownBody className="parent-update" outputAccessory={<span>Completed work log</span>}>{markdown}</MarkdownBody>));
    expect(fixture.parses).toBe(1);
    expect(host.textContent).toContain("Completed work log");
    await act(async () => root.render(<MarkdownBody>{markdown + "\n\nAnother sentence."}</MarkdownBody>));
    expect(fixture.parses).toBe(2);
    expect(host.textContent).toContain("Another sentence.");
  } finally { await act(async () => root.unmount()); }
});

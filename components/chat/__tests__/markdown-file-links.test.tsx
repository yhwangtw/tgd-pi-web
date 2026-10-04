// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownBody } from "../MarkdownBody";
import { onOpenFileRequest } from "@/lib/file-links";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let unsubscribe: (() => void) | undefined;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); unsubscribe?.(); });
async function render(text: string, sourceFilePath?: string) {
  container = document.createElement("div");
  container.dataset.entryId = "message-1";
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<MarkdownBody sourceFilePath={sourceFilePath}>{text}</MarkdownBody>));
  const opened = vi.fn();
  unsubscribe = onOpenFileRequest(opened);
  return opened;
}
describe("Markdown file link interaction", () => {
  it("carries the originating parallel conversation's project and session", async () => {
    const opened = await render("[Source](src/index.ts)");
    container.dataset.chatCwd = "/projects/parallel";
    container.dataset.chatSessionId = "parallel-session";
    container.querySelector("a")!.click();
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/projects/parallel", origin: { kind: "message", entryId: "message-1", sessionId: "parallel-session" } }));
  });
  it("opens a Markdown destination with message origin without navigating", async () => {
    const opened = await render('[報告](</workspace/中文 報告.pdf>)');
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    container.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(opened).toHaveBeenCalledWith({ path: "/workspace/中文 報告.pdf", line: undefined, origin: { kind: "message", entryId: "message-1" } });
  });
  it("lets the anchor destination win over a code-formatted label", async () => {
    const opened = await render('[`label.ts`](file:///workspace/actual.ts#L12)');
    container.querySelector("code")!.click();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0].path).toBe("/workspace/actual.ts");
    expect(opened.mock.calls[0][0].line).toBe(12);
    opened.mockClear();
    container.querySelector("code")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0].path).toBe("/workspace/actual.ts");
  });
  it("resolves nested preview links and selects HTML preview", async () => {
    const opened = await render('[Demo](../demo.html)', "/workspace/docs/README.md");
    container.querySelector("a")!.click();
    expect(opened.mock.calls[0][0]).toMatchObject({ path: "/workspace/demo.html", mode: "preview" });
  });
  it("preserves external links and filters unsafe schemes", async () => {
    const opened = await render('[Website](https://example.com) [Unsafe](javascript:alert)');
    const anchors = container.querySelectorAll("a");
    expect(anchors[0].target).toBe("_blank");
    expect(anchors[0].rel).toContain("noopener");
    expect(anchors[1].getAttribute("href")).toBe("");
    expect(opened).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Field, NumInput, Select, SecretTextInput } from "@/components/modals/models-config-forms";
import { FileInspectorDrawer } from "../FileInspectorDrawer";
import { PlainSourceView } from "../text-viewer/PlainSourceView";
import { BranchNavigator } from "@/components/chat/BranchNavigator";
import { getToolPreview } from "@/components/chat/AssistantMessageView";
import type { SessionTreeNode } from "@/lib/types";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
async function render(ui: React.ReactNode) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(ui));
}
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("full interface hardening", () => {
  it("summarizes object, array and unknown tool inputs without object coercion", () => {
    for (const input of [{ agents: [{ agent: "scout", task: "Inspect" }, { agent: "scout", task: "Verify" }] }, { value: { nested: true } }, { value: [null, { a: 2 }] }, { value: null }, { query: "x".repeat(400) }]) {
      const preview = getToolPreview({ type: "toolCall", toolCallId: "fixture", toolName: "fixture", input });
      expect(preview).not.toContain("[object Object]");
      expect(preview.length).toBeLessThanOrEqual(120);
    }
  });
  it("associates all model input types with unique, stable labels", async () => {
    const form = <><Field label="Context window"><NumInput value="1000" onChange={() => {}} /></Field><Field label="API override"><Select value="" onChange={() => {}} options={["responses"]} required /></Field><Field label="Credential"><SecretTextInput value="" onChange={() => {}} /></Field></>;
    await render(form);
    const labels = Array.from(container.querySelectorAll("label"));
    expect(labels.map(label => label.control?.tagName)).toEqual(["INPUT", "SELECT", "INPUT"]);
    const ids = labels.map(label => label.htmlFor);
    expect(new Set(ids).size).toBe(3);
    await act(async () => root.render(form));
    expect(Array.from(container.querySelectorAll("label")).map(label => label.htmlFor)).toEqual(ids);
    expect(container.querySelector("select")!.required).toBe(true);
  });
  it("keeps symbol controls usable after failure and sends one mode only", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "Retry lookup" }), { status: 500 })).mockResolvedValueOnce(new Response(JSON.stringify({ matches: [{ path: "sample.ts", line: 3, preview: "answer" }] })));
    vi.stubGlobal("fetch", fetcher);
    await render(<FileInspectorDrawer filePath="/fixture/sample.ts" relativePath="sample.ts" cwd="/fixture" outline={[]} onClose={() => {}} onGotoLine={() => {}} onCompareVersion={() => {}} />);
    const input = container.querySelector<HTMLInputElement>('[aria-label="Symbol"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "answer"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Retry lookup");
    expect(container.querySelector("form")).not.toBeNull();
    const references = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "References")!;
    await act(async () => references.click());
    expect(container.textContent).toContain("sample.ts:3");
    const params = new URL(fetcher.mock.calls[1][0], "http://fixture").searchParams;
    expect(params.getAll("mode")).toEqual(["references"]);
    expect(params.get("symbol")).toBe("answer");
  });
  it("bounds large source DOM and jumps/searches across pages", async () => {
    vi.stubGlobal("HTMLElement", HTMLElement);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const content = Array.from({ length: 16000 }, (_, i) => `line ${i + 1}`).join("\n");
    await render(<PlainSourceView content={content} />);
    expect(container.querySelectorAll("[data-line-number]")).toHaveLength(500);
    const next = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Next lines")!;
    await act(async () => next.click());
    expect(container.querySelector('[data-line-number="501"]')).not.toBeNull();
    await act(async () => root.render(<PlainSourceView content={content} activeLine={15888} />));
    expect(container.querySelector('[data-active-line]')!.textContent).toContain("15888");
    expect(container.querySelectorAll("[data-line-number]")).toHaveLength(500);
    expect(container.textContent).toContain("15501–16000 / 16000");
  });
  it("exposes native branch buttons with selection and arrow navigation", async () => {
    const node = (id: string, children: SessionTreeNode[] = []): SessionTreeNode => ({ entry: { type: "session_info", id, parentId: null, timestamp: "2026-10-11T00:00:00Z", name: id }, children });
    const select = vi.fn();
    await render(<BranchNavigator tree={[node("root", [node("left"), node("right")])]} activeLeafId="right" hasSession onLeafChange={select} />);
    await act(async () => container.querySelector("button")!.click());
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"));
    expect(options).toHaveLength(2);
    expect(options[1].getAttribute("aria-pressed")).toBe("true");
    options[0].focus();
    await act(async () => options[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(options[1]);
    await act(async () => options[0].click());
    expect(select).toHaveBeenCalledWith("left");
    expect(container.querySelector("button[aria-pressed]")).toBeNull();
  });
});

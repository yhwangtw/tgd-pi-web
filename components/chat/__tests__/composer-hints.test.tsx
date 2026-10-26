// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ChatInput } from "../ChatInput";
import { setLocale } from "@/lib/i18n";
import type { ComposerHintMessage } from "@/lib/composer-hints";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let serial = 0;
const onSend = vi.fn(async () => true);
const model = { provider: "fixture", modelId: "one" };
let context: ComposerHintMessage[];
let hintRequest: Mock<() => Promise<Response>>;
const node = (extra = {}) => <ChatInput onSend={onSend} onAbort={() => {}} isStreaming={false}
  persistKey="hint-test-session" hintMessages={context} model={model} {...extra} />;
const render = async (extra = {}) => { await act(async () => root.render(node(extra))); };
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 750)); }); };
const textarea = () => container.querySelector("textarea")!;
const hint = () => container.querySelector<HTMLButtonElement>('[data-testid="composer-hint"]');
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), text);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
  await act(async () => { textarea().dispatchEvent(event); });
  return event;
}
beforeEach(() => {
  localStorage.clear(); setLocale("en"); onSend.mockClear();
  context = [{ role: "user", text: `Fix preview ${serial++}` }, { role: "assistant", text: "Fixed. Test mobile next." }];
  hintRequest = vi.fn(async () => new Response(JSON.stringify({ hint: "Test the preview on mobile" })));
  vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/composer-hint" ? hintRequest() : Promise.resolve(new Response('{"prompts":[]}'))));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); setLocale("en"); });

describe("contextual composer suggestions", () => {
  it("keeps the draft empty until Tab accepts; Enter with only a hint never sends", async () => {
    await render(); await settle();
    expect(hint()?.textContent).toContain("Test the preview on mobile");
    expect(textarea().value).toBe("");
    await key("Enter"); expect(onSend).not.toHaveBeenCalled();
    expect((await key("Tab")).defaultPrevented).toBe(true);
    expect(textarea().value).toBe("Test the preview on mobile");
    expect(hint()).toBeNull(); expect(onSend).not.toHaveBeenCalled();
  });
  it("supports click acceptance and Escape dismissal without trapping ordinary Tab navigation", async () => {
    await render(); await settle();
    expect((await key("Tab", { shiftKey: true })).defaultPrevented).toBe(false);
    await act(async () => hint()!.click());
    expect(textarea().value).toBe("Test the preview on mobile");
    expect(onSend).not.toHaveBeenCalled();
    context = [{ role: "user", text: "Another question" }, { role: "assistant", text: "Another answer" }];
    await type(""); await render(); await settle();
    await key("Escape"); expect(hint()).toBeNull();
    expect((await key("Tab")).defaultPrevented).toBe(false);
  });
  it("never replaces a draft or accepts while an IME composition is active", async () => {
    await render(); await settle();
    expect((await key("Tab", { isComposing: true })).defaultPrevented).toBe(false);
    expect(textarea().value).toBe("");
    await type("我的草稿");
    expect(hint()).toBeNull();
    await key("Tab"); expect(textarea().value).toBe("我的草稿");
    await settle(); expect(hintRequest).toHaveBeenCalledTimes(1);
  });
  it("ignores a late response from a previous conversation and hides while running", async () => {
    let finish!: (response: Response) => void;
    hintRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(); await settle();
    await render({ persistKey: "different-session", hintMessages: null });
    await act(async () => { finish(new Response('{"hint":"Old session suggestion"}')); });
    expect(hint()).toBeNull();
    await render({ isStreaming: true }); await settle();
    expect(hint()).toBeNull(); expect(hintRequest).toHaveBeenCalledTimes(1);
  });
  it("respects the persisted opt-out without making a background request", async () => {
    localStorage.setItem("pi-composer-hints", "off");
    await render(); await settle();
    expect(hint()).toBeNull(); expect(hintRequest).not.toHaveBeenCalled();
    expect(textarea().placeholder).toBe("Message…");
  });
  it("recovers quietly from offline failures", async () => {
    hintRequest.mockRejectedValue(new Error("offline"));
    await render(); await settle();
    expect(hint()).toBeNull(); expect(textarea().placeholder).toBe("Message…");
    await type("Keep chatting"); await key("Enter");
    expect(onSend).toHaveBeenCalledWith("Keep chatting", undefined);
  });
  it("restores an accepted suggestion as soon as its draft is cleared without another model request", async () => {
    await render(); await settle();
    await key("Tab");
    expect(textarea().value).toBe("Test the preview on mobile");
    await type("");
    expect(hint()?.textContent).toContain("Test the preview on mobile");
    await settle(); expect(hintRequest).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });
  it("dismisses with Escape until the user edits and clears a draft, then restores the cached suggestion", async () => {
    await render(); await settle();
    await key("Escape"); await settle();
    expect(hint()).toBeNull(); expect(hintRequest).toHaveBeenCalledTimes(1);
    await type("An edited draft"); await type("");
    expect(hint()?.textContent).toContain("Test the preview on mobile");
    expect(onSend).not.toHaveBeenCalled();
  });
});

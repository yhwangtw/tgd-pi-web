// @vitest-environment jsdom
import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput, type ChatInputHandle } from "../ChatInput";
import { transferComposerDraft } from "@/hooks/useComposerDraft";
import { retainedComposerDraft } from "@/lib/composer-submissions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useToast", () => ({ showToast: toast }));
function deferred() {
  let resolve!: (value: boolean) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let serial = 0;
describe("composer delivery ownership", () => {
  let root: Root; let host: HTMLDivElement; let key: string;
  let props: ComponentProps<typeof ChatInput>;
  const handle = createRef<ChatInputHandle>();
  const input = () => host.querySelector("textarea")!;
  const saved = () => JSON.parse(sessionStorage.getItem(`pi-composer-delivery:${key}`) ?? "[]");
  const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent === text)!;
  async function render(extra: Partial<ComponentProps<typeof ChatInput>> = {}) {
    props = { ...props, ...extra }; await act(async () => root.render(<ChatInput {...props} />));
  }
  async function fill(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function enter(altKey = false, twice = false) {
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey, bubbles: true }));
      if (twice) input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey, bubbles: true }));
    });
  }
  async function image() {
    await act(async () => {
      handle.current!.addImages([new File(["png"], "test.png", { type: "image/png" })]);
      await new Promise(resolve => setTimeout(resolve, 20));
    });
  }
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem("pi-composer-hints", "off"); toast.mockClear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ prompts: [] }) }));
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
    URL.createObjectURL = vi.fn(() => "blob:test"); URL.revokeObjectURL = vi.fn();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    key = `delivery-${++serial}`;
    props = { ref: handle, onSend: vi.fn().mockResolvedValue(true), onAbort: vi.fn(), isStreaming: false, persistKey: key };
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("clears before acknowledgement, allows typing, guards duplicate Enter and preserves the next draft", async () => {
    const pending = deferred(); const onSend = vi.fn(() => pending.promise); await render({ onSend });
    await fill("first"); await enter(false, true);
    expect(onSend).toHaveBeenCalledExactlyOnceWith("first", undefined);
    expect(input().value).toBe(""); expect(input().readOnly).toBe(false); expect(input().getAttribute("aria-busy")).toBe("true");
    expect(saved()[0]).toMatchObject({ text: "first", status: "pending" });
    await fill("next draft"); await enter(); expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(true));
    expect(input().value).toBe("next draft"); expect(saved()).toEqual([]);
  });

  it.each(["false", "reject"])("restores a failed %s send including images, then removes backup on edited retry success", async mode => {
    const pending = deferred(); const onSend = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(true);
    await render({ onSend }); await fill("original"); await image(); await enter();
    expect(input().value).toBe(""); expect(host.querySelectorAll('img[src="blob:test"]')).toHaveLength(0);
    await act(async () => { if (mode === "reject") pending.reject(new Error("offline")); else pending.resolve(false); });
    expect(input().value).toBe("original"); expect(host.querySelector('img[src="data:image/png;base64,cG5n"]')).not.toBeNull();
    expect(saved()[0].status).toBe("restored");
    await fill("edited original"); await enter(); expect(saved()).toEqual([]);
    expect(onSend.mock.calls[1][1]).toEqual([expect.objectContaining({ data: "cG5n", mimeType: "image/png" })]);
  });

  it("keeps a failed message separate from a new draft and clears its backup after appended retry", async () => {
    const pending = deferred(); await render({ onSend: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(true) });
    await fill("original"); await enter(); await fill("new draft");
    await act(async () => pending.resolve(false)); expect(input().value).toBe("new draft");
    expect(saved()[0].status).toBe("failed");
    await act(async () => button("Add to draft").click()); expect(input().value).toBe("new draft\n\noriginal");
    await enter(); expect(saved()).toEqual([]);
  });

  it.each([false, true])("clears immediately for streaming delivery (steer=%s)", async steer => {
    const pending = deferred(); const send = vi.fn(() => pending.promise);
    await render({ isStreaming: true, onFollowUp: send, onSteer: send });
    await fill("queued"); await enter(steer); expect(input().value).toBe("");
    await fill("next queued"); await act(async () => pending.resolve(true)); expect(input().value).toBe("next queued");
    expect(send).toHaveBeenCalledExactlyOnceWith("queued", undefined);
  });

  it("does not restore a late failure into another session and can recover after returning", async () => {
    const pending = deferred(); await render({ onSend: () => pending.promise }); await fill("session A"); await enter();
    await render({ persistKey: `${key}-B` }); await fill("session B"); await act(async () => pending.resolve(false));
    expect(input().value).toBe("session B"); expect(host.textContent).not.toContain("Message not sent");
    await render({ persistKey: key }); expect(host.textContent).toContain("Message not sent");
    await act(async () => button("Restore draft").click()); expect(input().value).toBe("session A");
  });

  it("restores uncertain persisted sends without automatically replaying them", async () => {
    sessionStorage.setItem(`pi-composer-delivery:${key}`, JSON.stringify([{ id: "before-reload", text: "uncertain", images: [], status: "pending" }]));
    await render(); expect(host.textContent).toContain("Delivery unconfirmed"); expect(props.onSend).not.toHaveBeenCalled();
    await act(async () => button("Restore draft").click()); expect(input().value).toBe("uncertain");
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("keeps the original on storage failure and excludes it from a successful new-session handoff", async () => {
    const pending = deferred(); await render({ onSend: () => pending.promise }); await fill("original");
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, k, v) {
      if (this === sessionStorage) throw new DOMException("quota", "QuotaExceededError"); original.call(this, k, v);
    });
    await enter(); expect(input().value).toBe("original"); expect(input().readOnly).toBe(false);
    await act(async () => transferComposerDraft(key, `${key}-created`, retainedComposerDraft(key)));
    await render({ persistKey: `${key}-created` }); await act(async () => pending.resolve(true));
    expect(input().value).toBe("");
  });

  it("does not duplicate an original quote when restoring an image-only send after storage failure", async () => {
    const pending = deferred(); const clear = vi.fn();
    await render({ onSend: () => pending.promise, quote: { entryId: "quote", role: "assistant", text: "quoted" }, onClearQuote: clear });
    await image(); vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await enter(); expect(clear).not.toHaveBeenCalled();
    await act(async () => pending.resolve(false)); expect(input().value).toBe("> quoted\n\n"); expect(clear).toHaveBeenCalledOnce();
    await render({ quote: null, onSend: vi.fn().mockResolvedValue(true) }); await enter();
    expect(props.onSend).toHaveBeenCalledWith("> quoted", expect.any(Array));
  });

  it("does not offer to append an identical quoted draft after storage failure", async () => {
    await render({ onSend: vi.fn().mockResolvedValue(false), quote: { entryId: "quoted", role: "assistant", text: "Q" } });
    await fill("hello"); vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await enter(); expect(input().value).toBe("hello"); expect(button("Add to draft").disabled).toBe(true);
  });

  it("gives feedback for image attachment while acknowledgement is pending", async () => {
    const pending = deferred(); await render({ onSend: () => pending.promise }); await fill("first"); await enter(); await image();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("delivery confirmation"), { type: "info" });
    expect(host.querySelectorAll('img[src="blob:test"]')).toHaveLength(0);
    await act(async () => pending.resolve(true));
  });
});

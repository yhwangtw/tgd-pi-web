// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShortcutsDialog } from "../ShortcutsDialog";
import { FileOpsDialog } from "@/components/sidebar/FileOpsDialog";
import { ImageLightbox } from "@/components/chat/ImageLightbox";
import { UserMessageView } from "@/components/chat/UserMessageView";

vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  host = document.createElement("div"); host.inert = false; document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function key(target: Element | Document, name: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  return event;
}

it.each(["shortcuts", "file", "image"])("%s portals, contains focus, isolates the background and restores its launcher", async kind => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const close = () => setOpen(false);
    return <><button onClick={() => setOpen(true)}>launch</button>{open && (kind === "shortcuts"
      ? <ShortcutsDialog onClose={close} /> : kind === "image"
        ? <ImageLightbox src="/fixture.png" onClose={close} />
        : <FileOpsDialog req={{ kind: "rename", targetPath: "/fixture.ts", label: "fixture.ts", currentName: "fixture.ts" }} onClose={close} onSubmit={async () => null} />)}</>;
  }
  await act(async () => root.render(<Harness />));
  const launcher = host.querySelector("button")!; launcher.focus();
  await act(async () => launcher.click());
  const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(panel.getAttribute("aria-modal")).toBe("true");
  expect(host.contains(panel)).toBe(false);
  expect(panel.closest("[data-dialog-root]")!.parentElement).toBe(document.body);
  expect(panel.contains(document.activeElement)).toBe(true);
  expect(host.inert).toBe(true);
  const focusable = Array.from(panel.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled)"));
  const first = focusable[0], last = focusable.at(-1)!;
  last.focus(); await key(last, "Tab"); expect(document.activeElement).toBe(first);
  first.focus(); await key(first, "Tab", true); expect(document.activeElement).toBe(last);
  await key(last, "Escape");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(launcher);
  expect(host.inert).toBe(false);
});

it("starts delete on Cancel and keeps a pending file operation open, then exposes a retryable error", async () => {
  let reject: (error: Error) => void = () => {};
  const close = vi.fn();
  const submit = vi.fn(() => new Promise<string | null>((_resolve, fail) => { reject = fail; }));
  await act(async () => root.render(<FileOpsDialog req={{ kind: "delete", targetPath: "/fixture", label: "fixture" }} onClose={close} onSubmit={submit} />));
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'));
  expect(document.activeElement).toBe(buttons[0]);
  await act(async () => buttons[1].click());
  await key(document, "Escape");
  expect(close).not.toHaveBeenCalled();
  expect(buttons[0].disabled).toBe(true);
  await act(async () => reject(new Error("fixture operation failed")));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("fixture operation failed");
  expect(buttons[0].disabled).toBe(false);
});

it("does not dismiss the lightbox when inspecting the image and closes exactly once from X", async () => {
  const close = vi.fn();
  await act(async () => root.render(<ImageLightbox src="/fixture.png" onClose={close} />));
  await act(async () => document.querySelector<HTMLImageElement>('[role="dialog"] img')!.click());
  expect(close).not.toHaveBeenCalled();
  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click());
  expect(close).toHaveBeenCalledOnce();
});


it("opens attachment previews from a named native button and restores focus on close", async () => {
  await act(async () => root.render(<UserMessageView message={{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } },
  ] }} />));
  const launcher = host.querySelector<HTMLButtonElement>('button[aria-label="image.preview"]')!;
  expect(launcher.tagName).toBe("BUTTON");
  expect(launcher.tabIndex).toBe(0);
  expect(launcher.querySelector("img")).not.toBeNull();
  launcher.focus();
  await act(async () => launcher.click());
  const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(panel.contains(document.activeElement)).toBe(true);
  await key(document.activeElement!, "Escape");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(launcher);
});

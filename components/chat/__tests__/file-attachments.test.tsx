// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatInput, type ChatInputHandle } from "../ChatInput";
import { uploadFiles } from "@/lib/file-ops-client";
vi.mock("@/lib/file-ops-client", () => ({ uploadFiles: vi.fn() }));
vi.mock("@/hooks/usePrompts", () => ({ usePrompts: () => ({ prompts: [] }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const ref = createRef<ChatInputHandle>();
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); localStorage.clear(); });
it("only sends uploaded references, preserving edits made during upload", async () => {
  let complete!: (data: Awaited<ReturnType<typeof uploadFiles>>) => void;
  vi.mocked(uploadFiles).mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const send = vi.fn().mockResolvedValue(true);
  await act(async () => root.render(<ChatInput ref={ref} cwd="/project" persistKey="a" onSend={send} onAbort={() => {}} isStreaming={false} />));
  expect(host.querySelector('input[type="file"]')?.getAttribute("accept")).toBeNull();
  await act(async () => { ref.current!.setText("first"); ref.current!.addFiles([new File(["doc"], "notes 1.txt")]); });
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  expect(button.disabled).toBe(true);
  await act(async () => ref.current!.setText("edited"));
  await act(async () => complete({ results: [{ name: "notes 1.txt", ok: true }] }));
  expect(host.querySelector("textarea")!.value).toBe('edited\n@"notes 1.txt" ');
  await act(async () => button.click());
  expect(send).toHaveBeenCalledWith('edited\n@"notes 1.txt"', undefined);
  expect(host.querySelector("textarea")!.value).toBe("");
});
it("keeps failed attachments visible and requires retry or dismissal before sending", async () => {
  vi.mocked(uploadFiles).mockResolvedValue({ results: [], error: "offline" });
  const send = vi.fn();
  await act(async () => root.render(<ChatInput ref={ref} cwd="/project" onSend={send} onAbort={() => {}} isStreaming={false} />));
  await act(async () => { ref.current!.setText("draft"); ref.current!.addFiles([new File([], "notes.txt")]); });
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("offline");
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss upload error notes.txt"]')!.click());
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(false);
  expect(send).not.toHaveBeenCalled();
});

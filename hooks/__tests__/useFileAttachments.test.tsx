// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFileAttachments } from "../useFileAttachments";
import { uploadFiles } from "@/lib/file-ops-client";
vi.mock("@/lib/file-ops-client", () => ({ uploadFiles: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let state: ReturnType<typeof useFileAttachments>;
const received = vi.fn();
function Uploads({ id = "a", cwd = "/project" }: { id?: string; cwd?: string | null }) {
  const uploads = useFileAttachments(cwd, id, received);
  useLayoutEffect(() => { state = uploads; });
  return <span>{uploads.items.map(item => item.error ?? "uploading").join(",")}</span>;
}
beforeEach(() => { vi.clearAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("keeps sending blocked until a real upload succeeds", async () => {
  let finish!: (value: Awaited<ReturnType<typeof uploadFiles>>) => void;
  vi.mocked(uploadFiles).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<Uploads />));
  let pending!: Promise<void>;
  await act(async () => { pending = state.addFiles([new File(["data"], "report.txt")]); });
  expect(state.uploading).toBe(true);
  expect(received).not.toHaveBeenCalled();
  await act(async () => { finish({ results: [{ name: "report.txt", ok: true }] }); await pending; });
  expect(received).toHaveBeenCalledWith(["report.txt"]);
  expect(state.items).toEqual([]);
});
it("shows a retryable failure without adding a fake reference", async () => {
  vi.mocked(uploadFiles).mockResolvedValueOnce({ results: [], error: "offline" }).mockResolvedValueOnce({ results: [{ name: "report.txt", ok: true }] });
  await act(async () => root.render(<Uploads />));
  await act(async () => state.addFiles([new File(["data"], "report.txt")]));
  expect(received).not.toHaveBeenCalled();
  expect(state.items[0].error).toBe("offline");
  await act(async () => state.retry(state.items[0]));
  expect(received).toHaveBeenCalledWith(["report.txt"]);
});
it("aborts and ignores a late upload when switching conversations", async () => {
  let finish!: (value: Awaited<ReturnType<typeof uploadFiles>>) => void;
  vi.mocked(uploadFiles).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<Uploads />));
  let pending!: Promise<void>;
  await act(async () => { pending = state.addFiles([new File(["data"], "report.txt")]); });
  const signal = vi.mocked(uploadFiles).mock.calls[0][2];
  await act(async () => root.render(<Uploads id="b" />));
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish({ results: [{ name: "report.txt", ok: true }] }); await pending; });
  expect(received).not.toHaveBeenCalled();
  expect(state.items).toEqual([]);
});
it("rejects oversized and invalid names before transmitting bytes", async () => {
  const big = new File([], "big.zip"); Object.defineProperty(big, "size", { value: 51 * 1024 * 1024 });
  await act(async () => root.render(<Uploads />));
  await act(async () => state.addFiles([big, new File([], 'bad"name.txt')]));
  expect(uploadFiles).not.toHaveBeenCalled();
  expect(state.items.every(item => item.error)).toBe(true);
  await act(async () => state.dismiss(state.items[0].id));
  expect(state.items).toHaveLength(1);
});
it("requires an explicit project without uploading anywhere implicitly", async () => {
  await act(async () => root.render(<Uploads cwd={null} />));
  await act(async () => state.addFiles([new File(["data"], "report.txt")]));
  expect(uploadFiles).not.toHaveBeenCalled();
  expect(state.items[0].error).toContain("Choose a project");
});
it("cancels a pending attachment without inserting a late successful result", async () => {
  let finish!: (value: Awaited<ReturnType<typeof uploadFiles>>) => void;
  vi.mocked(uploadFiles).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<Uploads />));
  let pending!: Promise<void>;
  await act(async () => { pending = state.addFiles([new File(["data"], "cancel.txt")]); });
  const signal = vi.mocked(uploadFiles).mock.calls[0][2];
  await act(async () => state.dismiss(state.items[0].id));
  expect(signal?.aborted).toBe(true);
  expect(state.uploading).toBe(false);
  await act(async () => { finish({ results: [{ name: "cancel.txt", ok: true }] }); await pending; });
  expect(received).not.toHaveBeenCalled();
  expect(state.items).toEqual([]);
});

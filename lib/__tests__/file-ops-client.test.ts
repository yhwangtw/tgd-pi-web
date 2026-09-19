// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { uploadFiles } from "../file-ops-client";
afterEach(() => vi.unstubAllGlobals());
const file = new File(["hello"], "hello.txt");
it("validates a new workspace, uploads multipart and announces successful files", async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ name: file.name, ok: true }] }) });
  vi.stubGlobal("fetch", fetch);
  const changed = vi.fn(); window.addEventListener("pi:files-uploaded", changed, { once: true });
  expect(await uploadFiles("/new project", [file])).toEqual({ results: [{ name: file.name, ok: true }] });
  expect(fetch.mock.calls[0][0]).toBe("/api/cwd/validate");
  expect(fetch.mock.calls[1][1].body.get("files").name).toBe(file.name);
  expect(changed).toHaveBeenCalledOnce();
});
it("returns failures instead of swallowing network and malformed server responses", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  expect((await uploadFiles("/project", [file])).error).toContain("Connection lost");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true, json: async () => ({}) }));
  expect((await uploadFiles("/project", [file])).results[0].error).toBe("Invalid upload response");
});
it("does not transmit file data when workspace validation fails", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "No directory" }) });
  vi.stubGlobal("fetch", fetch);
  expect((await uploadFiles("/missing", [file])).error).toBe("No directory");
  expect(fetch).toHaveBeenCalledOnce();
});

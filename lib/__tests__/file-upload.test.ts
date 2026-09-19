import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../../app/api/files/[...path]/route";
import { POST as selectWorkspace } from "../../app/api/cwd/validate/route";
import { getAllowedRoots } from "../file-security";

vi.mock("../session-reader", () => ({ listAllSessions: async () => [] }));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-upload-test-"));
  globalThis.__piAllowedRootsCache = undefined;
});
afterEach(async () => {
  globalThis.__piSelectedWorkspaceRoots?.delete(root);
  globalThis.__piAllowedRootsCache = undefined;
  await rm(root, { recursive: true, force: true });
});
const upload = async (files: File[]) => {
  const form = new FormData();
  files.forEach(file => form.append("files", file));
  return POST(new NextRequest(`http://localhost/api/files/${root}`, { method: "POST", body: form }), {
    params: Promise.resolve({ path: root.split(sep).filter(Boolean) }),
  });
};
async function select() {
  return selectWorkspace(new Request("http://localhost/api/cwd/validate", {
    method: "POST", body: JSON.stringify({ cwd: root }),
  }));
}
it("allows a selected workspace before its first saved conversation, including a warm cache", async () => {
  await getAllowedRoots();
  expect((await upload([new File(["hello"], "report.txt")])).status).toBe(403);
  expect((await select()).status).toBe(200);
  const result = await upload([new File(["老大\nhello"], " report 1.txt ")]);
  expect((await result.json()).results).toEqual([{ name: "report 1.txt", ok: true }]);
  expect(await readFile(join(root, "report 1.txt"), "utf8")).toBe("老大\nhello");
});
it("keeps originals and dangling symlinks intact and continues with other files", async () => {
  await select();
  await writeFile(join(root, "existing.txt"), "original");
  await symlink(join(root, "missing.txt"), join(root, "alias.txt"));
  const result = await upload([new File(["replace"], "existing.txt"), new File(["escape"], "alias.txt"), new File(["safe"], "good.txt")]);
  expect((await result.json()).results).toEqual([
    { name: "existing.txt", ok: false, error: "Already exists" },
    { name: "alias.txt", ok: false, error: "Already exists" },
    { name: "good.txt", ok: true },
  ]);
  expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("original");
  await expect(readFile(join(root, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("resolves concurrent same-name uploads without overwriting the winner", async () => {
  await select();
  const responses = await Promise.all([upload([new File(["one"], "race.txt")]), upload([new File(["two"], "race.txt")])]);
  const results = await Promise.all(responses.map(response => response.json()));
  expect(results.filter(result => result.results[0].ok)).toHaveLength(1);
  expect(results.filter(result => result.results[0].error === "Already exists")).toHaveLength(1);
  expect(["one", "two"]).toContain(await readFile(join(root, "race.txt"), "utf8"));
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { applyPatch, reversePatch, structuredPatch } from "diff";
import { getAllowedRoots } from "./file-security";
import { contentDigest, FileOperationError, readFileSnapshot, replaceFileSnapshot, withFileMutation } from "./versioned-file";

const exec = promisify(execFile);
const MAX_BYTES = 1024 * 1024;
async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", ["-C", cwd, "--literal-pathspecs", ...args], { timeout: 10_000, maxBuffer: MAX_BYTES })).stdout;
}

export async function validateDiffPath(cwd: unknown, path: unknown) {
  if (typeof cwd !== "string" || !cwd || typeof path !== "string" || !path) throw new FileOperationError("cwd and path required", 400);
  if (!(await getAllowedRoots()).has(cwd)) throw new FileOperationError("cwd not allowed", 403);
  const rel = relative(cwd, resolve(cwd, path));
  if (isAbsolute(path) || path.startsWith("-") || !rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).includes(".git")) {
    throw new FileOperationError("path not allowed", 403);
  }
  return { cwd, path: rel.split(sep).join("/") };
}

export async function readGitDiff(cwd: string, path: string) {
  let head = "";
  try { head = (await git(cwd, ["rev-parse", "--verify", "HEAD"])).trim(); }
  catch { // An unborn repository is valid; a non-repository is not.
    await git(cwd, ["rev-parse", "--show-toplevel"]);
    await git(cwd, ["symbolic-ref", "HEAD"]);
  }
  const entry = head ? await git(cwd, ["ls-tree", "-z", head, "--", path]) : "";
  const oldExists = Boolean(entry);
  let oldText = "";
  if (entry) {
    const mode = entry.slice(0, 6);
    if (mode !== "100644" && mode !== "100755") throw new FileOperationError("Only regular text files support diff review", 415);
    const blob = `${head}:${path}`;
    if (Number(await git(cwd, ["cat-file", "-s", blob])) > MAX_BYTES) throw new FileOperationError("File is too large", 413);
    const { stdout: bytes } = await exec("git", ["-C", cwd, "show", blob], { encoding: "buffer", timeout: 10_000, maxBuffer: MAX_BYTES });
    oldText = bytes.toString("utf8");
    if (bytes.includes(0) || !Buffer.from(oldText).equals(bytes)) throw new FileOperationError("Binary files cannot be reviewed as text", 415);
  }
  const file = await readFileSnapshot(cwd, path, MAX_BYTES);
  if (!file.exists && entry) file.mode = parseInt(entry.slice(0, 6), 8) & 0o777;
  const patch = structuredPatch("file", "file", oldText, file.text, undefined, undefined, { context: 3, maxEditLength: 2048, timeout: 100 });
  const version = contentDigest(JSON.stringify([cwd, path, head, file.version]));
  const hunks = (patch?.hunks ?? []).map((hunk, index) => ({
    index, id: contentDigest(JSON.stringify([version, hunk])),
    oldStart: hunk.oldStart, newStart: hunk.newStart,
    label: `-${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`,
  }));
  return { oldText, newText: file.text, version, hunks, hunkLimitReached: !patch, file, patch, oldExists };
}

export async function revertGitHunk(cwd: string, path: string, index: number, version: string, hunkId: string) {
  return withFileMutation(cwd, path, async () => {
    const current = await readGitDiff(cwd, path);
    if (current.version !== version || current.hunks[index]?.id !== hunkId || !current.patch) {
      throw new FileOperationError("File changed; refresh before reverting a hunk", 409);
    }
    const patch = reversePatch({ ...current.patch, hunks: [current.patch.hunks[index]] });
    const text = applyPatch(current.newText, patch, { fuzzFactor: 0, autoConvertLineEndings: false });
    if (text === false) throw new FileOperationError("Hunk no longer applies; refresh and try again", 409);
    await replaceFileSnapshot(cwd, path, current.file, !current.oldExists && text === "" ? null : text, MAX_BYTES);
  });
}

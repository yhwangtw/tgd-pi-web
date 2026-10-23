import { NextResponse } from "next/server";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { DefaultResourceLoader, getAgentDir, parseFrontmatter, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { getAllowedRoots } from "@/lib/file-security";
import { resolveSearchRoot } from "@/lib/search-files";
import { isFileMutationLockPath } from "@/lib/file-mutation-lock";
import { FileOperationError, readFileSnapshot, replaceFileSnapshot, withFileMutation } from "@/lib/versioned-file";

export const dynamic = "force-dynamic";
const MAX_SKILL_BYTES = 1024 * 1024;

async function loadSkills(cwd: unknown) {
  if (typeof cwd !== "string" || !cwd) throw new FileOperationError("cwd required", 400);
  const workspace = await resolveSearchRoot(cwd, await getAllowedRoots());
  if (!workspace) throw new FileOperationError("cwd not allowed", 403);
  const loader = new DefaultResourceLoader({ cwd: workspace, agentDir: getAgentDir(), noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  return loader.getSkills();
}

// Loader membership authorizes global/package skills as well as workspace skills.
// Never turn a caller-provided path (or an arbitrary alias) into an editable root.
async function skillTarget(filePath: unknown, skills: Array<{ filePath: string }>) {
  if (typeof filePath !== "string" || !filePath) throw new FileOperationError("filePath required", 400);
  const member = skills.find(skill => resolve(skill.filePath) === resolve(filePath));
  if (!member || isFileMutationLockPath(member.filePath, getAgentDir())) throw new FileOperationError("Not a known editable skill file", 403);
  const info = await lstat(member.filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new FileOperationError("Skill must be a regular file", 403);
  const root = await realpath(dirname(member.filePath));
  const path = basename(member.filePath);
  return { root, path, memberPath: member.filePath };
}
function failure(error: unknown) {
  const status = error instanceof FileOperationError ? error.status : (error as NodeJS.ErrnoException)?.code === "ENOENT" ? 404 : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : "Skill operation failed" }, { status });
}

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const { skills, diagnostics } = await loadSkills(params.get("cwd"));
    const content = params.get("content");
    if (!content) return NextResponse.json({ skills, diagnostics });
    const target = await skillTarget(content, skills);
    const snapshot = await readFileSnapshot(target.root, target.path, MAX_SKILL_BYTES);
    if (!snapshot.exists) throw new FileOperationError("Skill not found", 404);
    return NextResponse.json({ content: stripFrontmatter(snapshot.text) });
  } catch (error) { return failure(error); }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown; filePath?: unknown; disableModelInvocation?: unknown };
    if (typeof body.disableModelInvocation !== "boolean") throw new FileOperationError("disableModelInvocation must be boolean", 400);
    const { skills } = await loadSkills(body.cwd);
    const target = await skillTarget(body.filePath, skills);
    await withFileMutation(target.root, target.path, async () => {
      const snapshot = await readFileSnapshot(target.root, target.path, MAX_SKILL_BYTES);
      if (!snapshot.exists) throw new FileOperationError("Skill not found", 404);
      const key = "disable-model-invocation";
      const { frontmatter } = parseFrontmatter<Record<string, unknown>>(snapshot.text);
      const alreadySet = Boolean(frontmatter[key]);
      let updated = snapshot.text;
      if (body.disableModelInvocation && !alreadySet) {
        updated = updated.replace(/^---\r?\n/, `---\n${key}: true\n`);
        if (updated === snapshot.text) updated = `---\n${key}: true\n---\n${snapshot.text}`;
      } else if (!body.disableModelInvocation && alreadySet) {
        updated = updated.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
      }
      // Re-resolve after loading and immediately before replacing; an alias
      // retargeted during this request must not redirect the write.
      const current = await skillTarget(body.filePath, skills);
      if (current.root !== target.root || current.path !== target.path) throw new FileOperationError("Skill path changed; refresh and retry", 409);
      if (updated !== snapshot.text) await replaceFileSnapshot(target.root, target.path, snapshot, updated, MAX_SKILL_BYTES);
    });
    return NextResponse.json({ success: true });
  } catch (error) { return failure(error); }
}

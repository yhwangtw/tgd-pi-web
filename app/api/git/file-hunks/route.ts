import { NextResponse } from "next/server";
import { revertGitHunk, validateDiffPath } from "@/lib/git-file-diff";
import { FileOperationError } from "@/lib/versioned-file";

export { GET } from "../file-diff/route";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  try {
    const { cwd, path } = await validateDiffPath(body.cwd, body.path);
    if (!Number.isInteger(body.index) || Number(body.index) < 0 ||
        typeof body.version !== "string" || !/^[a-f0-9]{64}$/.test(body.version) ||
        typeof body.hunkId !== "string" || !/^[a-f0-9]{64}$/.test(body.hunkId)) {
      throw new FileOperationError("A current version, hunk ID and index are required", 400);
    }
    await revertGitHunk(cwd, path, Number(body.index), body.version, body.hunkId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const status = error instanceof FileOperationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof FileOperationError ? error.message : "Unable to revert hunk" }, { status });
  }
}

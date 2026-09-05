import { NextResponse } from "next/server";
import { readGitDiff, validateDiffPath } from "@/lib/git-file-diff";
import { FileOperationError } from "@/lib/versioned-file";

export async function GET(req: Request) {
  const url = new URL(req.url);
  try {
    const { cwd, path } = await validateDiffPath(url.searchParams.get("cwd"), url.searchParams.get("path"));
    const { oldText, newText, version, hunks, hunkLimitReached } = await readGitDiff(cwd, path);
    return NextResponse.json({ oldText, newText, version, hunks, hunkLimitReached });
  } catch (error) {
    const status = error instanceof FileOperationError ? error.status : 500;
    if (status === 413) return NextResponse.json({ tooLarge: true, hunks: [] });
    return NextResponse.json({ error: error instanceof FileOperationError ? error.message : "Unable to read repository diff" }, { status });
  }
}

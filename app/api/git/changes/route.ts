import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { getAllowedRoots } from "@/lib/file-security";

const execFileAsync = promisify(execFile);

export interface ChangedFile {
  path: string;
  /** Porcelain status: M, A, D, R, ?? etc. */
  status: string;
  additions: number | null;
  deletions: number | null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return stdout;
}

// GET /api/git/changes?cwd=… — working-tree changes for a session cwd.
// The cwd must be one of the session roots (same policy as the file API).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  const roots = await getAllowedRoots();
  if (!roots.has(cwd)) {
    return NextResponse.json({ error: "cwd not allowed" }, { status: 403 });
  }

  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return NextResponse.json({ git: false, branch: null, files: [] });
  }

  try {
    const [branchOut, statusOut, numstatOut] = await Promise.all([
      git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
      git(cwd, ["status", "--porcelain=v1", "-z"]),
      git(cwd, ["diff", "--numstat", "-z", "HEAD"]).catch(() => ""),
    ]);

    const stats = new Map<string, { additions: number | null; deletions: number | null }>();
    // NUL-separated output preserves Unicode, whitespace and literal arrows.
    // Git's quoted format uses octal byte escapes, which are not JSON.
    const numstatRecords = numstatOut.split("\0");
    for (let i = 0; i < numstatRecords.length; i++) {
      const line = numstatRecords[i];
      if (!line) continue;
      const [a, d, ...rest] = line.split("\t");
      let p = rest.join("\t");
      // Renames/copies have an empty path followed by old and new paths.
      if (!p) { i += 2; p = numstatRecords[i]; }
      if (!p) continue;
      stats.set(p, {
        additions: a === "-" ? null : Number(a),
        deletions: d === "-" ? null : Number(d),
      });
    }

    const files: ChangedFile[] = [];
    const statusRecords = statusOut.split("\0");
    for (let i = 0; i < statusRecords.length; i++) {
      const line = statusRecords[i];
      if (!line) continue;
      const status = line.slice(0, 2).trim();
      const path = line.slice(3);
      // In -z porcelain, the destination is first and the source follows.
      if (/[RC]/.test(line.slice(0, 2))) i++;
      const s = stats.get(path);
      files.push({ path, status, additions: s?.additions ?? null, deletions: s?.deletions ?? null });
    }

    return NextResponse.json({ git: true, branch: branchOut.trim() || null, files });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

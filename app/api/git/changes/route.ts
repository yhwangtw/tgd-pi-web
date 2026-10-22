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

interface ChangesResult { git: boolean; branch: string | null; files: ChangedFile[]; }
// Only concurrent reads share work: edits/commits are visible on the next poll.
const pendingChanges = new Map<string, Promise<ChangesResult>>();
const MAX_PENDING_REPOSITORIES = 64;

async function readChanges(cwd: string): Promise<ChangesResult> {
  // Porcelain's branch header combines repository validation, branch and status.
  const statusPromise = git(cwd, ["status", "--porcelain=v1", "--branch", "-z"]);
  const numstatPromise = git(cwd, ["diff", "--numstat", "-z", "HEAD"]).catch(() => "");
  let statusOut: string;
  try { statusOut = await statusPromise; }
  catch (error) {
    try { await git(cwd, ["rev-parse", "--is-inside-work-tree"]); }
    catch { return { git: false, branch: null, files: [] }; }
    throw error;
  }
  const numstatOut = await numstatPromise;
  const records = statusOut.split("\0");
  const header = records[0]?.startsWith("## ") ? records.shift()!.slice(3) : "";
  const branch = /^(?:No commits yet on |Initial commit on )/.test(header) ? null
    : header === "HEAD (no branch)" ? "HEAD" : header.split("...")[0] || null;
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
  const statusRecords = records;
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

  return { git: true, branch, files };
}

function sharedChanges(cwd: string): Promise<ChangesResult> {
  const pending = pendingChanges.get(cwd);
  if (pending) return pending;
  const request = readChanges(cwd);
  if (pendingChanges.size >= MAX_PENDING_REPOSITORIES) return request;
  pendingChanges.set(cwd, request);
  void request.finally(() => { if (pendingChanges.get(cwd) === request) pendingChanges.delete(cwd); }).catch(() => {});
  return request;
}

// GET /api/git/changes?cwd=… — working-tree changes for a session cwd.
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  // Check every caller before sharing any result, including revoked workspaces.
  const roots = await getAllowedRoots();
  if (!roots.has(cwd)) return NextResponse.json({ error: "cwd not allowed" }, { status: 403 });
  try { return NextResponse.json(await sharedChanges(cwd)); }
  catch (error) { return NextResponse.json({ error: String(error) }, { status: 500 }); }
}

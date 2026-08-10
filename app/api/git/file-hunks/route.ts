import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { getAllowedRoots } from "@/lib/file-security";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 4 * 1024 * 1024;

async function validate(cwd: unknown, path: unknown) {
  if (typeof cwd !== "string" || typeof path !== "string") return { error: "cwd and path required", status: 400 } as const;
  const roots = await getAllowedRoots();
  if (!roots.has(cwd)) return { error: "cwd not allowed", status: 403 } as const;
  const abs = resolve(cwd, path);
  if (!abs.startsWith(cwd + sep) || path.startsWith("-")) return { error: "path not allowed", status: 403 } as const;
  return { cwd, path: path.split(sep).join("/") } as const;
}

async function diff(cwd: string, path: string) {
  return (await execFileAsync("git", ["-C", cwd, "diff", "HEAD", "--no-ext-diff", "--no-color", "--unified=3", "--", path], { timeout: 10_000, maxBuffer: MAX_BUFFER })).stdout;
}

function splitPatch(patch: string) {
  const firstHunk = patch.search(/^@@/m);
  if (firstHunk < 0) return { header: patch, hunks: [] as Array<{ patch: string; oldStart: number; newStart: number; label: string }> };
  const header = patch.slice(0, firstHunk);
  return {
    header,
    hunks: patch.slice(firstHunk).split(/(?=^@@)/m).filter(Boolean).map((part) => {
      const match = part.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/m);
      return { patch: part, oldStart: Number(match?.[1] ?? 1), newStart: Number(match?.[3] ?? 1), label: (match?.[5] ?? "").trim() };
    }),
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const checked = await validate(url.searchParams.get("cwd"), url.searchParams.get("path"));
  if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: checked.status });
  try {
    const parsed = splitPatch(await diff(checked.cwd, checked.path));
    return NextResponse.json({ hunks: parsed.hunks.map(({ oldStart, newStart, label }, index) => ({ index, oldStart, newStart, label })) });
  } catch (error) { return NextResponse.json({ error: String(error) }, { status: 500 }); }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { cwd?: unknown; path?: unknown; index?: unknown };
  const checked = await validate(body.cwd, body.path);
  if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: checked.status });
  if (!Number.isInteger(body.index) || Number(body.index) < 0) return NextResponse.json({ error: "valid hunk index required" }, { status: 400 });
  let dir = "";
  try {
    const parsed = splitPatch(await diff(checked.cwd, checked.path));
    const hunk = parsed.hunks[Number(body.index)];
    if (!hunk) return NextResponse.json({ error: "hunk no longer exists; refresh and try again" }, { status: 409 });
    dir = await mkdtemp(join(tmpdir(), "pi-file-hunk-"));
    const patchPath = join(dir, "revert.patch");
    await writeFile(patchPath, `${parsed.header}${hunk.patch}`, "utf8");
    await execFileAsync("git", ["-C", checked.cwd, "apply", "--reverse", "--recount", patchPath], { timeout: 10_000, maxBuffer: MAX_BUFFER });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

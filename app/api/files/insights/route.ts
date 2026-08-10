import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolve, relative, sep } from "path";
import { stat } from "fs/promises";
import { getAllowedRoots } from "@/lib/file-security";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 4 * 1024 * 1024;

interface Diagnostic {
  source: "typescript" | "eslint" | "test";
  line: number;
  column: number;
  severity: "error" | "warning";
  code?: string;
  message: string;
}

async function validate(cwd: string | null, requestedPath: string | null) {
  if (!cwd || !requestedPath) return { error: "cwd and path required", status: 400 } as const;
  const roots = await getAllowedRoots();
  if (!roots.has(cwd)) return { error: "cwd not allowed", status: 403 } as const;
  const abs = resolve(cwd, requestedPath);
  if ((abs !== cwd && !abs.startsWith(cwd + sep)) || requestedPath.startsWith("-")) return { error: "path not allowed", status: 403 } as const;
  try { if (!(await stat(abs)).isFile()) return { error: "not a file", status: 400 } as const; }
  catch { return { error: "not found", status: 404 } as const; }
  return { cwd, abs, relPath: relative(cwd, abs).split(sep).join("/") } as const;
}

async function git(cwd: string, args: string[]) {
  return (await execFileAsync("git", ["-C", cwd, ...args], { timeout: 15_000, maxBuffer: MAX_BUFFER })).stdout;
}

function parseTsc(stdout: string, cwd: string, abs: string, relPath: string): Diagnostic[] {
  const normalizedAbs = abs.replace(/\\/g, "/");
  return stdout.split("\n").flatMap((line) => {
    const match = line.match(/^(.*)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/);
    if (!match) return [];
    const reported = resolve(cwd, match[1]).replace(/\\/g, "/");
    if (reported !== normalizedAbs && !reported.endsWith(`/${relPath}`)) return [];
    return [{ source: "typescript" as const, line: Number(match[2]), column: Number(match[3]), severity: match[4] === "warning" ? "warning" as const : "error" as const, code: `TS${match[5]}`, message: match[6] }];
  });
}

async function diagnostics(cwd: string, abs: string, relPath: string): Promise<Diagnostic[]> {
  const results: Diagnostic[] = [];
  const tsc = resolve(cwd, "node_modules/.bin/tsc");
  try {
    const output = await execFileAsync(tsc, ["--noEmit", "--pretty", "false"], { cwd, timeout: 30_000, maxBuffer: MAX_BUFFER });
    results.push(...parseTsc(`${output.stdout}\n${output.stderr}`, cwd, abs, relPath));
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    results.push(...parseTsc(`${e.stdout ?? ""}\n${e.stderr ?? ""}`, cwd, abs, relPath));
  }

  const eslint = resolve(cwd, "node_modules/.bin/eslint");
  try {
    const output = await execFileAsync(eslint, ["--format", "json", "--no-warn-ignored", relPath], { cwd, timeout: 20_000, maxBuffer: MAX_BUFFER });
    const payload = JSON.parse(output.stdout || "[]") as Array<{ messages?: Array<{ line?: number; column?: number; severity?: number; ruleId?: string | null; message?: string }> }>;
    for (const message of payload[0]?.messages ?? []) results.push({ source: "eslint", line: message.line ?? 1, column: message.column ?? 1, severity: message.severity === 1 ? "warning" : "error", code: message.ruleId ?? undefined, message: message.message ?? "ESLint issue" });
  } catch (error) {
    const e = error as { stdout?: string };
    try {
      const payload = JSON.parse(e.stdout || "[]") as Array<{ messages?: Array<{ line?: number; column?: number; severity?: number; ruleId?: string | null; message?: string }> }>;
      for (const message of payload[0]?.messages ?? []) results.push({ source: "eslint", line: message.line ?? 1, column: message.column ?? 1, severity: message.severity === 1 ? "warning" : "error", code: message.ruleId ?? undefined, message: message.message ?? "ESLint issue" });
    } catch { /* unsupported project or formatter output */ }
  }
  return results.slice(0, 250);
}

async function testDiagnostics(cwd: string, relPath: string): Promise<Diagnostic[]> {
  const vitest = resolve(cwd, "node_modules/.bin/vitest");
  let stdout = "";
  try {
    const result = await execFileAsync(vitest, ["related", relPath, "--run", "--reporter=json", "--passWithNoTests"], { cwd, timeout: 60_000, maxBuffer: MAX_BUFFER });
    stdout = result.stdout;
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  if (!stdout.trim()) return [];
  try {
    const payload = JSON.parse(stdout) as { testResults?: Array<{ name?: string; assertionResults?: Array<{ title?: string; status?: string; failureMessages?: string[]; location?: { line?: number; column?: number } }> }> };
    const out: Diagnostic[] = [];
    for (const file of payload.testResults ?? []) {
      for (const assertion of file.assertionResults ?? []) {
        if (assertion.status !== "failed") continue;
        out.push({ source: "test", line: assertion.location?.line ?? 1, column: assertion.location?.column ?? 1, severity: "error", code: file.name?.split(/[\\/]/).pop() ?? "test", message: `${assertion.title ?? "Test failed"}: ${(assertion.failureMessages?.[0] ?? "failure").replace(/\u001b\[[0-9;]*m/g, "").slice(0, 800)}` });
      }
    }
    return out.slice(0, 100);
  } catch { return []; }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const checked = await validate(url.searchParams.get("cwd"), url.searchParams.get("path"));
  if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: checked.status });
  const mode = url.searchParams.get("mode") ?? "history";
  try {
    if (mode === "diagnostics") return NextResponse.json({ diagnostics: await diagnostics(checked.cwd, checked.abs, checked.relPath) });
    if (mode === "tests") return NextResponse.json({ diagnostics: await testDiagnostics(checked.cwd, checked.relPath) });
    if (mode === "history") {
      const output = await git(checked.cwd, ["log", "--follow", "-n", "40", "--date=iso-strict", "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s", "--", checked.relPath]);
      const commits = output.trim().split("\n").filter(Boolean).map((line) => {
        const [sha, shortSha, author, date, ...subject] = line.split("\x1f");
        return { sha, shortSha, author, date, subject: subject.join("\x1f") };
      });
      return NextResponse.json({ commits });
    }
    if (mode === "version") {
      const ref = url.searchParams.get("ref");
      if (!ref || !/^[0-9a-f]{7,40}$/i.test(ref)) return NextResponse.json({ error: "valid ref required" }, { status: 400 });
      const content = await git(checked.cwd, ["show", `${ref}:${checked.relPath}`]);
      return NextResponse.json({ content, ref });
    }
    if (mode === "blame") {
      const output = await git(checked.cwd, ["blame", "--line-porcelain", "HEAD", "--", checked.relPath]);
      const lines: Array<{ line: number; sha: string; author: string; date: string; text: string }> = [];
      let current = { sha: "", line: 0, author: "", date: "" };
      for (const row of output.split("\n")) {
        const header = row.match(/^([0-9a-f^]{7,40})\s+\d+\s+(\d+)/i);
        if (header) current = { sha: header[1], line: Number(header[2]), author: "", date: "" };
        else if (row.startsWith("author ")) current.author = row.slice(7);
        else if (row.startsWith("author-time ")) current.date = new Date(Number(row.slice(12)) * 1000).toISOString();
        else if (row.startsWith("\t")) lines.push({ ...current, text: row.slice(1) });
      }
      return NextResponse.json({ lines: lines.slice(0, 5_000) });
    }
    return NextResponse.json({ error: "unsupported mode" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// ============================================================================
// Content search across a project tree.
//
// Prefers ripgrep (fast, skips binaries) and falls back
// to a bounded pure-JS scan when `rg` isn't on PATH — so the feature works on
// any self-host box without assuming ripgrep is installed.
// ============================================================================

import { execFile } from "child_process";
import { promisify } from "util";
import { lstat } from "fs/promises";
import path from "path";
import { readSearchFile, walkSearchFiles, type SearchFile, type SearchWalkOptions } from "./search-files";

const execFileAsync = promisify(execFile);

export interface GrepMatch {
  /** Path relative to the searched root (what the UI shows). */
  relative: string;
  /** Absolute path (what the file-open API takes). */
  full: string;
  line: number;
  /** 1-based column of the first match on the line (best-effort). */
  col: number;
  /** The matching line, trimmed to a sane length. */
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  /** "rg" or "js" — which engine served the result (handy for debugging). */
  engine: "rg" | "js";
}

const LINE_CLAMP = 400; // don't ship enormous minified lines to the client

function clampLine(s: string): string {
  return s.length > LINE_CLAMP ? s.slice(0, LINE_CLAMP) + "…" : s;
}

/** Parse `rg --json` stream output into matches. */
export function parseRgJson(stdout: string, root: string, maxResults: number): GrepMatch[] {
  const out: GrepMatch[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw || out.length >= maxResults) break;
    let evt: unknown;
    try { evt = JSON.parse(raw); } catch { continue; }
    const e = evt as { type?: string; data?: {
      path?: { text?: string };
      lines?: { text?: string };
      line_number?: number;
      submatches?: { start?: number }[];
    } };
    if (e.type !== "match" || !e.data?.path?.text) continue;
    const full = e.data.path.text;
    out.push({
      relative: path.relative(root, full),
      full,
      line: e.data.line_number ?? 0,
      // rg reports bytes; the viewer/JS fallback use UTF-16 columns.
      col: Buffer.from(e.data.lines?.text ?? "").subarray(0, e.data.submatches?.[0]?.start ?? 0).toString("utf8").length + 1,
      text: clampLine((e.data.lines?.text ?? "").replace(/\r?\n$/, "")),
    });
  }
  return out;
}

async function grepWithRg(
  root: string, query: string, files: SearchFile[],
  opts: { caseSensitive: boolean; maxResults: number; signal?: AbortSignal; deadline: number },
): Promise<GrepMatch[]> {
  if (!files.length) return [];
  const args = [
    "--json", "--fixed-strings", "--no-config", "--no-ignore", "--hidden", "--threads", "1",
    opts.caseSensitive ? "--case-sensitive" : "--ignore-case",
    "--max-count", String(opts.maxResults),
    "--max-filesize", "1M",
    "--", query, ...files.map((file) => file.full),
  ];
  const { stdout } = await execFileAsync("rg", args, {
    timeout: Math.max(1, opts.deadline - Date.now()),
    maxBuffer: 8 * 1024 * 1024,
    signal: opts.signal,
  }).catch((err: NodeJS.ErrnoException & { stdout?: string; code?: number }) => {
    // rg exits 1 when there are simply no matches — that's not an error.
    if (err.code === 1 && typeof err.stdout === "string") return { stdout: err.stdout };
    throw err;
  });
  return parseRgJson(stdout, root, opts.maxResults);
}

/** Cheap binary sniff: a NUL byte in the first chunk. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function scanWithJs(
  files: SearchFile[], query: string,
  opts: { caseSensitive: boolean; maxResults: number; signal?: AbortSignal; deadline: number },
): Promise<{ matches: GrepMatch[]; truncated: boolean }> {
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  const out: GrepMatch[] = [];
  let truncated = false;
  for (const file of files) {
      opts.signal?.throwIfAborted();
      if (Date.now() >= opts.deadline) { truncated = true; break; }
      if (out.length >= opts.maxResults) break;
      try {
        const buf = await readSearchFile(file.full);
        if (!buf || looksBinary(buf)) continue;
        const lines = buf.toString("utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const hay = opts.caseSensitive ? lines[i] : lines[i].toLowerCase();
          const col = hay.indexOf(needle);
          if (col >= 0) {
            out.push({
              relative: file.relative,
              full: file.full,
              line: i + 1,
              col: col + 1,
              text: clampLine(lines[i].replace(/\r$/, "")),
            });
            if (out.length >= opts.maxResults) break;
          }
        }
      } catch { truncated = true; }
  }
  return { matches: out, truncated };
}

type GrepOptions = SearchWalkOptions & { caseSensitive?: boolean; maxResults?: number; maxFiles?: number; engine?: "js" };

/** Public fallback helper shares exactly the same project traversal. */
export async function grepWithJs(root: string, query: string, opts: GrepOptions): Promise<GrepMatch[]> {
  return (await grepProject(root, query, { ...opts, engine: "js" })).matches;
}

/**
 * Search `root` for `query` (literal substring). Tries ripgrep, falls back to
 * the JS scanner if `rg` is missing or errors.
 */
export async function grepProject(
  root: string, query: string,
  opts: GrepOptions = {},
): Promise<GrepResult> {
  const caseSensitive = opts.caseSensitive ?? false;
  const maxResults = opts.maxResults ?? 300;
  const tree = await walkSearchFiles(root, opts);
  const files: SearchFile[] = [];
  let truncated = tree.truncated;
  let bytes = 0;
  const deadline = Date.now() + 15_000;
  for (const entry of tree.entries) {
    opts.signal?.throwIfAborted();
    if (entry.isDir) continue;
    if (files.length >= (opts.maxFiles ?? 5000) || bytes >= 100 * 1024 * 1024 || Date.now() >= deadline) { truncated = true; break; }
    try {
      const stat = await lstat(entry.full);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      files.push(entry);
      bytes += stat.size;
    } catch { truncated = true; }
  }
  let engine: "rg" | "js" = opts.engine ?? "rg";
  const matches: GrepMatch[] = [];
  // Explicit bounded batches prevent argv/buffer blowups. rg never performs
  // its own traversal or uses machine-specific ignore/config rules.
  for (let offset = 0; offset < files.length && matches.length <= maxResults; offset += 64) {
    opts.signal?.throwIfAborted();
    if (Date.now() >= deadline) { truncated = true; break; }
    const batch = files.slice(offset, offset + 64);
    const scanOptions = { caseSensitive, maxResults: maxResults + 1 - matches.length, signal: opts.signal, deadline };
    if (engine === "rg") {
      try { matches.push(...await grepWithRg(root, query, batch, scanOptions)); continue; }
      catch { opts.signal?.throwIfAborted(); engine = "js"; }
    }
    const result = await scanWithJs(batch, query, scanOptions);
    matches.push(...result.matches);
    truncated ||= result.truncated;
  }
  opts.signal?.throwIfAborted();
  return { matches: matches.slice(0, maxResults), truncated: truncated || matches.length > maxResults, engine };
}

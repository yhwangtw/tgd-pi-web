import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { advancesReadReceipt, isReadReceipt, type SessionReadReceipt } from "./session-read-receipt";

export interface SessionReadSnapshot { scope: string; receipts: Record<string, SessionReadReceipt> }
let cache: { path: string; signature: string; receipts: Record<string, SessionReadReceipt> } | undefined;

function path() { return join(getAgentDir(), "session-reads.json"); }
function readReceipts(): Record<string, SessionReadReceipt> {
  const file = path();
  const stat = existsSync(file) ? statSync(file) : null;
  const signature = stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}` : "missing";
  if (cache?.path === file && cache.signature === signature) return cache.receipts;
  const receipts: Record<string, SessionReadReceipt> = Object.create(null);
  if (stat) {
    // A broken store is an error, not permission to overwrite all read progress.
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data.version !== 1 || !data.receipts || typeof data.receipts !== "object") throw new Error("Invalid session read store");
    for (const [id, receipt] of Object.entries(data.receipts)) if (isReadReceipt(receipt)) receipts[id] = receipt;
  }
  cache = { path: file, signature, receipts };
  return receipts;
}

export function getSessionReadSnapshot(): SessionReadSnapshot {
  return { scope: createHash("sha256").update(getAgentDir()).digest("hex").slice(0, 24), receipts: readReceipts() };
}

/** Synchronous merge + atomic rename: no await between reading and replacing. */
export function saveSessionReadReceipts(updates: Record<string, SessionReadReceipt>): SessionReadSnapshot {
  const previous = readReceipts();
  const receipts = Object.assign(Object.create(null), previous) as Record<string, SessionReadReceipt>;
  let changed = false;
  for (const [id, next] of Object.entries(updates)) {
    if (isReadReceipt(next) && advancesReadReceipt(next, receipts[id])) { receipts[id] = next; changed = true; }
  }
  if (changed) {
    const file = path();
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, receipts }), { mode: 0o600 });
    renameSync(temporary, file);
    cache = undefined;
  }
  return getSessionReadSnapshot();
}

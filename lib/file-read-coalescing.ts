import type { Stats } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const pending = new Map<string, Promise<unknown>>();
const MAX_PENDING_READS = 64;

/** Share overlapping reads only, after every caller's permission and stat check.
 * No completed file contents or permission decisions are retained. */
export function coalesceFileRead<T>(kind: string, filePath: string, stat: Stats, roots: Set<string>, read: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([getAgentDir(), kind, filePath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, [...roots].sort()]);
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const result = read();
  if (pending.size >= MAX_PENDING_READS) return result;
  pending.set(key, result);
  void result.finally(() => { if (pending.get(key) === result) pending.delete(key); }).catch(() => {});
  return result;
}

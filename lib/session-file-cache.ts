import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionHeader } from "./types";

interface SessionFile { header: SessionHeader | null; entries: SessionEntry[]; }
interface CachedFile { revision: string; bytes: number; value: SessionFile; }
interface ReaderOptions { maxFiles?: number; maxBytes?: number; maxFileBytes?: number; }

function revision(value: Stats): string {
  return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode].join(":");
}

/** Native cloning has a lower nesting limit than JSON parsing/stringifying.
 * Keep deeply nested tool details readable without sharing mutable cache objects.
 */
function copySessionFile(value: SessionFile): SessionFile {
  try { return structuredClone(value); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const root: Record<string, unknown> = {};
    const seen = new WeakMap<object, object>([[value, root]]);
    const pending: Array<[object, object]> = [[value, root]];
    while (pending.length) {
      const [source, target] = pending.pop()!;
      for (const key of Object.keys(source)) {
        const field: unknown = (source as Record<string, unknown>)[key];
        let copy = field;
        if (field && typeof field === "object") {
          copy = seen.get(field);
          if (!copy) {
            copy = Array.isArray(field) ? new Array(field.length) : {};
            seen.set(field, copy as object);
            pending.push([field, copy as object]);
          }
        }
        // JSON may contain an own __proto__ key; never invoke a prototype setter.
        Object.defineProperty(target, key, { value: copy, enumerable: true, writable: true, configurable: true });
      }
    }
    return root as unknown as SessionFile;
  }
}

/** Read-only native JSONL cache. Callers receive private copies, never SDK-owned entries. */
export function createSessionFileReader({ maxFiles = 12, maxBytes = 16 * 1024 * 1024, maxFileBytes = 4 * 1024 * 1024 }: ReaderOptions = {}) {
  const cache = new Map<string, CachedFile>();
  const pending = new Map<string, Promise<SessionFile>>();
  let bytes = 0;
  const discard = (path: string) => {
    const previous = cache.get(path);
    if (previous) { bytes -= previous.bytes; cache.delete(path); }
  };
  const parse = (content: string): SessionFile => {
    const parsed = parseSessionEntries(content) as unknown as Array<SessionHeader | SessionEntry>;
    migrateSessionEntries(parsed as never);
    return {
      header: (parsed.find(entry => entry.type === "session") as SessionHeader | undefined) ?? null,
      entries: parsed.filter((entry): entry is SessionEntry => entry.type !== "session"),
    };
  };
  return async (path: string): Promise<SessionFile> => {
    let before: Stats;
    try { before = await stat(path); }
    catch (error) { discard(path); throw error; }
    const key = revision(before);
    const cached = cache.get(path);
    if (cached?.revision === key) {
      cache.delete(path); cache.set(path, cached);
      return copySessionFile(cached.value);
    }
    discard(path);
    const pendingKey = `${path}\0${key}`;
    let work = pending.get(pendingKey);
    if (!work) {
      work = (async () => {
        let content = await readFile(path, "utf8");
        let after = await stat(path);
        // An append/replacement during the read must not poison a warm revision.
        if (revision(after) !== key) {
          const readingRevision = revision(after);
          content = await readFile(path, "utf8");
          after = await stat(path);
          if (revision(after) !== readingRevision) return parse(content);
        }
        const value = parse(content);
        const size = Buffer.byteLength(content, "utf8");
        if (size <= maxFileBytes && size <= maxBytes && maxFiles > 0) {
          discard(path);
          cache.set(path, { revision: revision(after), bytes: size, value });
          bytes += size;
          while (cache.size > maxFiles || bytes > maxBytes) discard(cache.keys().next().value!);
        }
        return value;
      })();
      pending.set(pendingKey, work);
    }
    try { return copySessionFile(await work); }
    finally { if (pending.get(pendingKey) === work) pending.delete(pendingKey); }
  };
}

// Modules share one bounded cache per server process, not one per request/session.
export const readSessionFileCached = createSessionFileReader();

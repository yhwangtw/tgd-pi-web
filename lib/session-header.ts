import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { SessionHeader } from "./types";

/** Bounded, read-only JSONL header access. No migration or transcript parsing. */
export function readSessionHeader(filePath: string): SessionHeader | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const chunks: Buffer[] = [];
    const maxBytes = 1024 * 1024;
    let offset = 0;
    let ended = false;
    while (offset < maxBytes) {
      const buffer = Buffer.alloc(Math.min(4096, maxBytes - offset));
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (!count) { ended = true; break; }
      const newline = buffer.subarray(0, count).indexOf(10);
      chunks.push(buffer.subarray(0, newline < 0 ? count : newline));
      offset += count;
      if (newline >= 0) { ended = true; break; }
    }
    if (!ended) return null;
    const header = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return header?.type === "session" && typeof header.id === "string" && typeof header.cwd === "string" ? header : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

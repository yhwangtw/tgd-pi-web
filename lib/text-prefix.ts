import { openSync, readSync, closeSync } from "fs";
import { open } from "node:fs/promises";

/**
 * Trim a buffer so it doesn't end mid-UTF-8-sequence. A byte-count cut can
 * land inside a multibyte character (CJK, emoji); decoding that tail would
 * yield a U+FFFD replacement char at the end of the preview.
 */
export function trimToUtf8Boundary(buf: Buffer): Buffer {
  let i = buf.length - 1;
  let continuations = 0;
  // Walk back over trailing continuation bytes (0b10xxxxxx), max 3.
  while (i >= 0 && continuations < 3 && (buf[i] & 0xc0) === 0x80) {
    i--;
    continuations++;
  }
  if (i < 0) return buf.subarray(0, 0);
  const lead = buf[i];
  const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  // Sequence complete → keep everything; incomplete → cut before its lead.
  return i + seqLen > buf.length ? buf.subarray(0, i) : buf;
}

/**
 * Read at most `maxBytes` from the start of a file and decode as UTF-8,
 * never splitting a character. Reads via fd so a multi-GB file only costs
 * `maxBytes` of memory.
 */
export function readTextPrefixSync(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return trimToUtf8Boundary(buf.subarray(0, bytesRead)).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** Nonblocking equivalent for HTTP previews; memory remains bounded by maxBytes. */
export async function readTextPrefix(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    let length = 0;
    while (length < maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, maxBytes - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return trimToUtf8Boundary(buffer.subarray(0, length)).toString("utf-8");
  } finally { await handle.close(); }
}

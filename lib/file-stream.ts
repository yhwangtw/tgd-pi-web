import fs from "fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "path";
import { FileOperationError } from "./versioned-file";
import { previewContentSecurityPolicy } from "./preview-policy";

interface StreamOptions {
  range?: { start: number; end: number };
  signal?: AbortSignal;
}

function fileStamp(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

/** Owns the descriptor, including cancellation before the first read. No read-ahead. */
function createFileBodyStream(handle: FileHandle, stat: fs.Stats, options: StreamOptions = {}): ReadableStream<Uint8Array> {
  const { range, signal } = options;
  let position = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  let closed = false;
  let closing: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const close = () => {
    closed = true;
    signal?.removeEventListener("abort", abort);
    return closing ??= handle.close().catch(() => {});
  };
  const fail = async (error: unknown) => {
    if (closed) return;
    await close();
    controller.error(error);
  };
  const abort = () => { void fail(new DOMException("File response was aborted", "AbortError")); };

  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull() {
      if (closed) return;
      try {
        if (position > end) {
          await close();
          controller.close();
          return;
        }
        const before = await handle.stat();
        if (closed) return;
        if (fileStamp(before) !== fileStamp(stat)) throw new FileOperationError("File changed during download; retry", 409);
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - position + 1));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (closed) return;
        const after = await handle.stat();
        if (closed) return;
        if (!bytesRead || fileStamp(after) !== fileStamp(stat)) throw new FileOperationError("File changed during download; retry", 409);
        position += bytesRead;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, bytesRead));
        if (position > end) {
          await close();
          controller.close();
        }
      } catch (error) { await fail(error); }
    },
    cancel: close,
  }, { highWaterMark: 0 });
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(filePath: string, kind: "inline" | "attachment"): string {
  const fileName = path.basename(filePath);
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

async function streamFile(
  filePath: string,
  stat: fs.Stats,
  contentType: string,
  rangeHeader: string | null,
  disposition: "inline" | "attachment" = "inline",
  options: { handle?: FileHandle; signal?: AbortSignal } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Accept-Ranges": "bytes",
    "Content-Disposition": getContentDisposition(filePath, disposition),
  };
  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml" || mime === "image/svg+xml") {
    headers["Content-Security-Policy"] = previewContentSecurityPolicy(mime === "text/html");
  }
  const handle = options.handle ?? await open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new FileOperationError("Not a regular file", 400);
    if (fileStamp(opened) !== fileStamp(stat)) throw new FileOperationError("File changed; retry the request", 409);
    let range: StreamOptions["range"];
    if (rangeHeader !== null) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      let start = match?.[1] ? Number(match[1]) : 0;
      let end = match?.[2] ? Number(match[2]) : stat.size - 1;
      if (match && !match[1] && match[2]) {
        const suffix = Number(match[2]);
        start = Number.isSafeInteger(suffix) && suffix > 0 ? Math.max(stat.size - suffix, 0) : NaN;
        end = stat.size - 1;
      }
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
        await handle.close();
        return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
      }
      range = { start, end: Math.min(end, stat.size - 1) };
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
    }
    headers["Content-Length"] = String(range ? range.end - range.start + 1 : stat.size);
    return new Response(createFileBodyStream(handle, opened, { range, signal: options.signal }), {
      status: range ? 206 : 200, headers,
    });
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapDocxPreviewHtml(bodyHtml: string, fileName: string): string {
  // All colors below are hardcoded equivalents of the project's light-theme
  // design tokens (see app/globals.css :root block). This HTML is served as a
  // standalone page so it cannot reference CSS custom properties.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; background: #f5f5f5; color: #1a1a1a; } /* --bg-panel, --text */
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; }
  main {
    box-sizing: border-box;
    max-width: 840px;
    min-height: calc(100vh - 56px);
    margin: 0 auto;
    padding: 56px 64px;
    background: #ffffff; /* --bg */
    box-shadow: 0 8px 28px rgba(15,23,42,0.14);
  }
  .file-title {
    margin: 0 0 28px;
    padding-bottom: 10px;
    border-bottom: 1px solid #e0e0e0; /* --border */
    color: #6b7280; /* --text-muted */
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-word;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.1em 0 0.45em; color: #1a1a1a; } /* --text */
  p { margin: 0.65em 0; line-height: 1.7; }
  table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #e0e0e0; padding: 6px 9px; vertical-align: top; } /* --border */
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  a { color: #2563eb; } /* --accent */
  @media (max-width: 720px) {
    body { padding: 0; background: #ffffff; }
    main { min-height: 100vh; padding: 28px 22px; box-shadow: none; }
  }
</style>
</head>
<body>
<main>
<div class="file-title">${escapeHtml(fileName)}</div>
${bodyHtml}
</main>
</body>
</html>`;
}

export {
  createFileBodyStream,
  encodeHeaderValue,
  getContentDisposition,
  streamFile,
  escapeHtml,
  wrapDocxPreviewHtml,
};

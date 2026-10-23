import fs from "node:fs";

/** The stream owns its watcher on every termination path. */
export function watchFileResponse(filePath: string, signal: AbortSignal): Response {
  let watcher: fs.FSWatcher | undefined;
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const cleanup = () => {
    signal.removeEventListener("abort", stop);
    watcher?.close();
    watcher = undefined;
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    cleanup();
    try { controller.close(); } catch { /* already canceled */ }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) { stop(); return; }
      const send = (event: string, data: Record<string, unknown>) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
        catch { stop(); }
      };
      try {
        watcher = fs.watch(filePath, () => {
          if (closed) return;
          try {
            const stat = fs.statSync(filePath);
            send("change", { mtime: stat.mtime.toISOString(), size: stat.size });
          } catch { send("change", { mtime: new Date().toISOString(), size: 0 }); }
        });
        watcher.on("error", stop);
        send("connected", { filePath });
      } catch { send("error", { message: "Failed to watch file" }); stop(); }
    },
    cancel() { if (!closed) { closed = true; cleanup(); } },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  } });
}

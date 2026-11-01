import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);
const MIN_COMPRESS_BYTES = 16 * 1024;
type Compressor = (body: Buffer) => Promise<Buffer>;
interface ResponseOptions { maxEntries?: number; maxBytes?: number; compressor?: Compressor; }

function acceptsGzip(value: string | null): boolean {
  if (!value) return false;
  let wildcard = 0;
  for (const item of value.split(",")) {
    const [name, ...parameters] = item.trim().toLowerCase().split(";");
    const quality = parameters.find(part => part.trim().startsWith("q="));
    const text = quality?.trim().slice(2);
    const q = text === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(text) ? Number(text) : 0;
    if (name.trim() === "gzip") return q > 0;
    if (name.trim() === "*") wildcard = q;
  }
  return wildcard > 0;
}

/** Only completed JSON responses are compressed; SSE remains unbuffered. */
export function createSessionJsonResponder({ maxEntries = 12, maxBytes = 8 * 1024 * 1024, compressor = body => compress(body, { level: 3 }) }: ResponseOptions = {}) {
  // Hash the authorized response, including live settings/state. File revision
  // alone cannot safely key those fields. Retain compressed bytes only.
  const cache = new Map<string, Buffer>();
  const pending = new Map<string, Promise<Buffer>>();
  let bytes = 0;
  const compressBody = async (body: Buffer): Promise<Buffer> => {
    const key = createHash("sha256").update(body).digest("hex");
    const cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
    const existing = pending.get(key);
    if (existing) return existing;
    const work = compressor(body).then(result => {
      if (maxEntries > 0 && result.byteLength < body.byteLength && result.byteLength <= maxBytes) {
        const previous = cache.get(key);
        if (previous) { bytes -= previous.byteLength; cache.delete(key); }
        while (cache.size >= maxEntries || bytes + result.byteLength > maxBytes) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          bytes -= cache.get(oldest)!.byteLength; cache.delete(oldest);
        }
        cache.set(key, result); bytes += result.byteLength;
      }
      return result;
    });
    // Bound bookkeeping when distinct responses arrive concurrently; requests
    // beyond this limit still complete without adding retained in-flight state.
    if (pending.size < 4) pending.set(key, work);
    try { return await work; }
    finally { if (pending.get(key) === work) pending.delete(key); }
  };
  return async (request: Request, data: unknown, varyTree = false): Promise<Response> => {
    const body = Buffer.from(JSON.stringify(data), "utf8");
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      Vary: varyTree ? "X-Pi-Session-Tree, Accept-Encoding" : "Accept-Encoding",
    });
    if (body.byteLength >= MIN_COMPRESS_BYTES && acceptsGzip(request.headers.get("accept-encoding"))) {
      const compressed = await compressBody(body);
      if (compressed.byteLength < body.byteLength) {
        headers.set("Content-Encoding", "gzip");
        headers.set("Content-Length", String(compressed.byteLength));
        return new Response(Uint8Array.from(compressed), { headers });
      }
    }
    return new Response(Uint8Array.from(body), { headers });
  };
}

export const sessionJsonResponse = createSessionJsonResponder();

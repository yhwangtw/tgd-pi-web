import { createHash } from "node:crypto";

type SavedResponse = { status: number; body: string };
type Entry = { fingerprint: string; expiresAt: number; response: Promise<SavedResponse> };
const errorResponse = (status: number, error: string) => Response.json({ error }, { status });

/** Transport retries must not reopen the old runtime and fork a second time.
 * Entries survive hot reload but intentionally not server restarts. Pending
 * operations never expire; completed entries remain for the SSE alias lifetime.
 */
export class ForkRequestCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly options: { maxEntries?: number; ttlMs?: number; maxResponseBytes?: number } = {}) {}

  async run(sessionId: string, key: string | null, command: Record<string, unknown>, execute: () => Promise<Response>): Promise<Response> {
    if (key === null) return execute();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
      return errorResponse(400, "Invalid fork request key");
    }
    const now = Date.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
    const id = `${sessionId}:${key.toLowerCase()}`;
    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const previous = this.entries.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return errorResponse(409, "Fork request key was already used with different arguments");
      const saved = await previous.response;
      return new Response(saved.body, { status: saved.status, headers: { "Content-Type": "application/json" } });
    }
    // Never evict unexpired keys to admit another operation: that would silently
    // remove retry protection. Bound both retained entries and each reply.
    if (this.entries.size >= (this.options.maxEntries ?? 64)) return errorResponse(503, "Too many recent fork requests; try again later");
    let settle!: (response: SavedResponse) => void;
    const entry: Entry = { fingerprint, expiresAt: Infinity, response: new Promise(resolve => { settle = resolve; }) };
    this.entries.set(id, entry);
    let response: Response;
    try { response = await execute(); }
    catch (error) { response = errorResponse(500, String(error)); }
    try {
      const body = await response.clone().text();
      const saved = Buffer.byteLength(body) <= (this.options.maxResponseBytes ?? 64 * 1024)
        ? { status: response.status, body }
        : { status: 409, body: JSON.stringify({ error: "Fork already completed; reconnect to recover its current session" }) };
      settle(saved);
    } catch {
      settle({ status: 409, body: JSON.stringify({ error: "Fork result is uncertain; reconnect before trying another fork" }) });
    }
    entry.expiresAt = Date.now() + (this.options.ttlMs ?? 10 * 60_000);
    return response;
  }
}

declare global { var __piForkRequests: ForkRequestCache | undefined }
export const forkRequests = globalThis.__piForkRequests ??= new ForkRequestCache();

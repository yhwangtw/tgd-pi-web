// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

function forkRequestKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // getRandomValues also works on explicitly configured HTTP LAN origins.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  // Keep the receipt on the action object so a lost-ACK retry of that action
  // cannot admit another Durable model run.
  if (["prompt", "steer", "follow_up", "queue_compaction_prompt", "compact", "bash"].includes(String(command.type)) && !command.requestId) {
    command.requestId = forkRequestKey();
  }
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(command.type === "fork" ? { "Idempotency-Key": forkRequestKey() } : {}),
    },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    migration?: { sourceId: string; sessionId: string; status: string; reason?: string };
  };
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  if (body.migration && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pi-session-migration", { detail: body.migration }));
  return body.data as T;
}

import { getAssistantFailure } from "./assistant-outcome";

/** Local, content-free timings. Client and server durations use separate clocks. */
export type RunLatencyStatus = "running" | "completed" | "failed" | "aborted" | "interrupted";
export type ServerLatencyStage = "accepted" | "provider_request" | "first_content" | "completed";
export interface RunLatencyRecord {
  timingId: string;
  status: RunLatencyStatus;
  requestSentMs?: number;
  firstEventMs?: number;
  firstContentMs?: number;
  firstCommitMs?: number;
  displayLagMs?: number;
  completedMs?: number;
  server: Partial<Record<ServerLatencyStage, number>>;
}
const serverStages = new Set<ServerLatencyStage>(["accepted", "provider_request", "first_content", "completed"]);
const recent: RunLatencyRecord[] = [];
const LIMIT = 30;

/** No prompt, response, model credentials or session content enter the diagnostic. */
export function readRunLatencyRecords(): RunLatencyRecord[] {
  return recent.map(record => ({ ...record, server: { ...record.server } }));
}
function report(record: RunLatencyRecord, started: number) {
  if (typeof window === "undefined") return;
  const copy = { ...record, server: { ...record.server } };
  const existing = recent.findIndex(item => item.timingId === copy.timingId);
  if (existing < 0) recent.push(copy); else recent[existing] = copy;
  while (recent.length > LIMIT) {
    const removed = recent.shift()!;
    performance.clearMeasures?.(`pi.web.run:${removed.timingId}`);
  }
  // Events allow a local audit to observe metrics without a persistent log or
  // adding diagnostic chrome to the user's conversation.
  window.dispatchEvent(new CustomEvent("pi-run-latency", { detail: copy }));
  if (record.status !== "running" && record.completedMs !== undefined) {
    try {
      const name = `pi.web.run:${record.timingId}`;
      performance.clearMeasures(name);
      performance.measure(name, { start: started, duration: record.completedMs, detail: copy });
    } catch { /* Performance detail is optional in older browsers. */ }
  }
}
function hasText(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const message = value as { role?: string; content?: unknown };
  return message.role === "assistant" && Array.isArray(message.content)
    && message.content.some(block => block?.type === "text" && typeof block.text === "string" && block.text.length > 0);
}
function id(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const text = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

export class RunLatencyTracker {
  private current: { started: number; value: RunLatencyRecord; pendingCommit: boolean } | null = null;
  constructor(private readonly now: () => number = () => performance.now(),
    private readonly publish: (record: RunLatencyRecord, started: number) => void = report) {}

  begin(timingId = id()): string {
    this.finish("interrupted");
    this.current = { started: this.now(), value: { timingId, status: "running", server: {} }, pendingCommit: false };
    this.changed();
    return timingId;
  }
  private elapsed(): number { return Math.max(0, this.now() - this.current!.started); }
  private changed() {
    const current = this.current;
    if (current) this.publish({ ...current.value, server: { ...current.value.server } }, current.started);
  }
  requestSent(timingId: string) {
    if (this.current?.value.timingId !== timingId || this.current.value.status !== "running") return;
    this.current.value.requestSentMs ??= this.elapsed();
    this.changed();
  }
  record(event: { type: string; [key: string]: unknown }) {
    const current = this.current;
    if (!current) return;
    const value = current.value;
    if (event.type === "run_timing") {
      if (event.timingId !== value.timingId || !serverStages.has(event.stage as ServerLatencyStage)
        || typeof event.elapsedMs !== "number" || !Number.isFinite(event.elapsedMs) || event.elapsedMs < 0
        || value.status === "interrupted") return;
      const stage = event.stage as ServerLatencyStage;
      if (value.server[stage] === undefined) { value.server[stage] = event.elapsedMs; this.changed(); }
      return;
    }
    if (value.status !== "running" || value.requestSentMs === undefined) return;
    // A reconnect is not a fresh provider response. Do not report buffered
    // historical output as the live request's first-content or display latency.
    if (["connected", "session_snapshot", "session_restart", "session_closed", "session_replaced"].includes(event.type)) {
      this.finish("interrupted"); return;
    }
    if (["agent_start", "message_start", "message_update", "message_end", "agent_end"].includes(event.type)) {
      if (value.firstEventMs === undefined) { value.firstEventMs = this.elapsed(); this.changed(); }
    }
    if (["message_start", "message_update", "message_end"].includes(event.type) && hasText(event.message) && value.firstContentMs === undefined) {
      value.firstContentMs = this.elapsed(); current.pendingCommit = true; this.changed();
    }
    if (event.type === "agent_end") {
      const messages = Array.isArray(event.messages) ? event.messages : [];
      const assistant = [...messages].reverse().find(message => message?.role === "assistant");
      this.finish(getAssistantFailure(assistant) ? "failed" : assistant?.stopReason === "aborted" ? "aborted" : "completed");
    }
  }
  /** Called in React's layout effect after the received text reaches the DOM.
   * This measures a DOM commit, not a claim about the physical display's paint. */
  committed(renderedMessage: unknown) {
    const current = this.current;
    if (!current?.pendingCommit || current.value.status === "interrupted" || !hasText(renderedMessage)) return;
    current.pendingCommit = false;
    current.value.firstCommitMs = this.elapsed();
    current.value.displayLagMs = Math.max(0, current.value.firstCommitMs - current.value.firstContentMs!);
    this.changed();
  }
  /** Cancelling the local send only proves a stop before dispatch. After the
   * request was sent, an unknown/failed abort receipt cannot establish aborted. */
  cancelPendingSend() {
    this.finish(this.current?.value.requestSentMs === undefined ? "aborted" : "interrupted");
  }
  finish(status: Exclude<RunLatencyStatus, "running">) {
    const current = this.current;
    if (!current || current.value.status !== "running") return;
    current.value.status = status;
    current.value.completedMs = this.elapsed();
    if (status === "interrupted") current.pendingCommit = false;
    this.changed();
  }
}

export type RunTimingStage = "accepted" | "provider_request" | "first_content" | "completed";
export interface RunTimingEvent {
  type: "run_timing";
  timingId: string;
  stage: RunTimingStage;
  elapsedMs: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Host observations only: provider_request does not prove remote receipt. */
export class RunLatencyServer {
  private active: { token: symbol; timingId: string; started: number; elapsed: number; stages: Set<RunTimingStage> } | null = null;
  constructor(private readonly emit: (event: RunTimingEvent) => void, private readonly now = () => performance.now()) {}

  accept(timingId: unknown): symbol | null {
    if (this.active || typeof timingId !== "string" || !UUID.test(timingId)) return null;
    const token = Symbol();
    this.active = { token, timingId, started: this.now(), elapsed: 0, stages: new Set() };
    this.record(this.active, "accepted");
    return token;
  }
  isActive(token: symbol): boolean { return this.active?.token === token; }
  has(stage: RunTimingStage): boolean { return this.active?.stages.has(stage) ?? false; }
  mark(stage: Exclude<RunTimingStage, "accepted" | "completed">): void {
    const active = this.active;
    if (!active || active.stages.has(stage)) return;
    this.record(active, stage);
  }
  private record(active: NonNullable<RunLatencyServer["active"]>, stage: RunTimingStage): void {
    active.stages.add(stage);
    const elapsedMs = Math.max(active.elapsed, Math.round(Math.max(0, this.now() - active.started) * 100) / 100);
    active.elapsed = elapsedMs;
    // A diagnostics consumer must never reject a provider request or a prompt.
    try { this.emit({ type: "run_timing", timingId: active.timingId, stage, elapsedMs }); } catch { /* observation only */ }
  }
  observe(event: { type?: unknown; message?: unknown }): void {
    if (!this.active) return;
    if (event.type === "agent_end") { this.complete(); return; }
    if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") return;
    if (this.has("first_content")) return;
    const message = event.message as { role?: unknown; content?: unknown } | null | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    if (message.content.some((block: unknown) => {
      if (!block || typeof block !== "object") return false;
      const value = block as { type?: unknown; text?: unknown; thinking?: unknown };
      if (value.type === "text") return typeof value.text === "string" && value.text.length > 0;
      if (value.type === "thinking") return typeof value.thinking === "string" && value.thinking.length > 0;
      return value.type === "toolCall" || value.type === "image";
    })) this.mark("first_content");
  }
  complete(expected?: symbol): void {
    const active = this.active;
    if (!active || (expected !== undefined && expected !== active.token)) return;
    // Clear before emitting so terminal observers cannot attach a stage to the
    // old run, and an async settlement cannot clear a newer prompt's trace.
    this.active = null;
    this.record(active, "completed");
  }
  cancel(): void { this.active = null; }
}

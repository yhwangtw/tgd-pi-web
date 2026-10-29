import { randomUUID } from "node:crypto";
import { classifyCompactionError, type CompactionState } from "./compaction-state";

/** Transport-independent status; Pi still owns eligibility, summarization and storage. */
export class CompactionController {
  state: CompactionState | null = null;
  private requests = new Map<string, CompactionState>();
  private revision = 0;

  constructor(private readonly compact: (instructions?: string) => Promise<unknown>, private readonly changed: (state: CompactionState) => void) {}

  private snapshotOf(state: CompactionState): CompactionState {
    return { ...state, observedAt: Math.max(Date.now(), state.startedAt) };
  }

  snapshot(): CompactionState | null {
    return this.state ? this.snapshotOf(this.state) : null;
  }

  private publish(state: CompactionState) {
    const next = { ...state, revision: ++this.revision };
    this.state = next;
    this.requests.set(next.id, next);
    while (this.requests.size > 32) this.requests.delete(this.requests.keys().next().value!);
    this.changed(this.snapshotOf(next));
  }

  start(id: string, instructions?: string): CompactionState {
    const previous = this.requests.get(id);
    if (previous) return this.snapshotOf(previous);
    if (this.state?.status === "running") return this.snapshotOf(this.state);
    const state: CompactionState = { id, status: "running", reason: "manual", startedAt: Date.now() };
    this.publish(state);
    // Return acceptance immediately; never hold HTTP open for the model call.
    void Promise.resolve().then(() => this.compact(instructions)).then(
      (result) => this.finish(id, { result }),
      (error) => this.finish(id, { error }),
    );
    return this.snapshot()!;
  }

  observe(event: { type: string; [key: string]: unknown }) {
    if (event.type === "compaction_start" || event.type === "auto_compaction_start") {
      if (this.state?.status === "running") return;
      this.publish({ id: randomUUID(), status: "running", reason: String(event.reason ?? "auto"), startedAt: Date.now() });
    } else if (event.type === "compaction_end" || event.type === "auto_compaction_end") {
      if (!this.state || this.state.status !== "running") return;
      this.finish(this.state.id, { result: event.result, error: event.errorMessage, aborted: event.aborted === true, willRetry: event.willRetry === true });
    } else if (event.type === "summarization_retry_scheduled" && this.state?.status === "running") {
      const { attempt, maxAttempts } = event;
      if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1
        || typeof maxAttempts !== "number" || !Number.isSafeInteger(maxAttempts) || maxAttempts < attempt) return;
      this.publish({ ...this.state, retry: { status: "waiting", attempt, maxAttempts } });
    } else if (event.type === "summarization_retry_attempt_start" && event.source === "compaction"
      && this.state?.status === "running" && this.state.retry) {
      this.publish({ ...this.state, retry: { ...this.state.retry, status: "retrying" } });
    } else if (event.type === "summarization_retry_finished" && this.state?.status === "running" && this.state.retry) {
      const next = { ...this.state };
      delete next.retry;
      this.publish(next);
    }
  }

  private finish(id: string, outcome: { result?: unknown; error?: unknown; aborted?: boolean; willRetry?: boolean }) {
    if (this.state?.id !== id || this.state.status !== "running") return;
    const result = outcome.result as CompactionState["result"] | undefined;
    const status = outcome.aborted ? { status: "cancelled" as const }
      : outcome.error !== undefined ? classifyCompactionError(outcome.error)
      : result ? { status: "completed" as const, result: { tokensBefore: result.tokensBefore, estimatedTokensAfter: result.estimatedTokensAfter } }
      : { status: "skipped" as const, notice: "nothing_to_compact" as const };
    const next = { ...this.state, ...status, willRetry: outcome.willRetry };
    delete next.retry;
    this.publish(next);
  }
}

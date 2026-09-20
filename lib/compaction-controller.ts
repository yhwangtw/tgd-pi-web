import { randomUUID } from "node:crypto";
import { classifyCompactionError, type CompactionState } from "./compaction-state";

/** Transport-independent status; Pi still owns eligibility, summarization and storage. */
export class CompactionController {
  state: CompactionState | null = null;
  private requests = new Map<string, CompactionState>();

  constructor(private readonly compact: (instructions?: string) => Promise<unknown>, private readonly changed: (state: CompactionState) => void) {}

  private publish(state: CompactionState) {
    this.state = state;
    this.requests.set(state.id, state);
    while (this.requests.size > 32) this.requests.delete(this.requests.keys().next().value!);
    this.changed(state);
  }

  start(id: string, instructions?: string): CompactionState {
    const previous = this.requests.get(id);
    if (previous) return previous;
    if (this.state?.status === "running") return this.state;
    const state: CompactionState = { id, status: "running", reason: "manual", startedAt: Date.now() };
    this.publish(state);
    // Return acceptance immediately; never hold HTTP open for the model call.
    void Promise.resolve().then(() => this.compact(instructions)).then(
      (result) => this.finish(id, { result }),
      (error) => this.finish(id, { error }),
    );
    return state;
  }

  observe(event: { type: string; [key: string]: unknown }) {
    if (event.type === "compaction_start" || event.type === "auto_compaction_start") {
      if (this.state?.status === "running") return;
      this.publish({ id: randomUUID(), status: "running", reason: String(event.reason ?? "auto"), startedAt: Date.now() });
    } else if (event.type === "compaction_end" || event.type === "auto_compaction_end") {
      if (!this.state || this.state.status !== "running") return;
      this.finish(this.state.id, { result: event.result, error: event.errorMessage, aborted: event.aborted === true, willRetry: event.willRetry === true });
    }
  }

  private finish(id: string, outcome: { result?: unknown; error?: unknown; aborted?: boolean; willRetry?: boolean }) {
    if (this.state?.id !== id || this.state.status !== "running") return;
    const result = outcome.result as CompactionState["result"] | undefined;
    const status = outcome.aborted ? { status: "cancelled" as const }
      : outcome.error !== undefined ? classifyCompactionError(outcome.error)
      : result ? { status: "completed" as const, result: { tokensBefore: result.tokensBefore, estimatedTokensAfter: result.estimatedTokensAfter } }
      : { status: "skipped" as const, notice: "nothing_to_compact" as const };
    this.publish({ ...this.state, ...status, willRetry: outcome.willRetry });
  }
}

export interface CompactionState {
  id: string;
  status: "running" | "completed" | "skipped" | "cancelled" | "failed";
  reason: string;
  startedAt: number;
  result?: { tokensBefore: number; estimatedTokensAfter: number };
  notice?: "already_compacted" | "nothing_to_compact";
  error?: string;
  willRetry?: boolean;
}

/** Only Pi's exact no-op outcomes are neutral; provider failures stay failures. */
export function classifyCompactionError(error: unknown): Pick<CompactionState, "status" | "notice" | "error"> {
  const message = (error instanceof Error ? error.message : String(error)).replace(/^(?:(?:Error|Compaction failed):\s*)+/i, "").trim();
  if (message === "Already compacted") return { status: "skipped", notice: "already_compacted" };
  if (message === "Nothing to compact (session too small)") return { status: "skipped", notice: "nothing_to_compact" };
  if (/^(?:Compaction cancel(?:led|ed)|(?:The operation was )?aborted\.?)$/i.test(message) || (error instanceof Error && error.name === "AbortError")) {
    return { status: "cancelled" };
  }
  return { status: "failed", error: message };
}

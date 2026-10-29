import type { AgentMessage } from "./types";
import type { ActiveTool } from "./tool-activity";

export type AgentPhase =
  | { kind: "stopping"; tools?: undefined }
  | { kind: "waiting_model" | "thinking" | "preparing_tools" | "writing"; tools?: undefined }
  | { kind: "running_tools"; tools: ActiveTool[] }
  | null;

/** Authoritative metadata for one live SDK run, independent of browser subscriptions. */
export interface AgentRunState {
  id: string;
  startedAt: number;
  lastProgressAt: number;
  observedAt: number;
  phase: AgentPhase;
}

const PROGRESS_EVENTS = new Set([
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "turn_start", "turn_end", "auto_retry_start", "auto_retry_end",
  "auto_compaction_start", "auto_compaction_end", "bash_start", "bash_chunk", "bash_end",
]);

/** Transport keepalives, UI notifications and timing receipts are not work. */
export function isRunProgressEvent(type: string): boolean {
  return PROGRESS_EVENTS.has(type);
}

export function runProgressAttention(idleSeconds: number, phase: AgentPhase) {
  const tools = phase?.kind === "running_tools";
  return idleSeconds >= (tools ? 300 : 180) ? "stalled"
    : idleSeconds >= (tools ? 180 : 90) ? "delayed" : "normal";
}

export function phaseForMessage(message?: Partial<AgentMessage>): AgentPhase {
  if (message?.role !== "assistant") return { kind: "waiting_model" };
  const last = message.content?.at(-1);
  if (last?.type === "thinking") return { kind: "thinking" };
  if (last?.type === "toolCall") return { kind: "preparing_tools" };
  if (last?.type === "text" && last.text) return { kind: "writing" };
  return { kind: "waiting_model" };
}

export function keepActivePhase(current: AgentPhase, next: AgentPhase): AgentPhase {
  return current?.kind === next?.kind || current?.kind === "stopping" || (current?.kind === "running_tools" && current.tools.length > 0) ? current : next;
}

/** Map server elapsed time to this browser's clock, including clock-skewed devices. */
export function restoreRunClock(run: AgentRunState | null | undefined, now = Date.now()) {
  if (!run?.id || ![run.startedAt, run.lastProgressAt, run.observedAt].every(Number.isFinite)
    || run.startedAt < 0 || run.lastProgressAt < run.startedAt || run.observedAt < run.lastProgressAt) return null;
  return {
    id: run.id,
    startedAt: now - (run.observedAt - run.startedAt),
    lastProgressAt: now - (run.observedAt - run.lastProgressAt),
  };
}

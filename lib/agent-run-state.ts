import type { AgentMessage } from "./types";

export type AgentPhase =
  | { kind: "stopping"; tools?: undefined }
  | { kind: "waiting_model" | "thinking" | "preparing_tools" | "writing"; tools?: undefined }
  | { kind: "running_tools"; tools: { id: string; name: string; label?: string }[] }
  | null;

/** Authoritative metadata for one live SDK run, independent of browser subscriptions. */
export interface AgentRunState {
  id: string;
  startedAt: number;
  lastProgressAt: number;
  observedAt: number;
  phase: AgentPhase;
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

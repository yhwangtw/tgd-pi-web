import type { ToolResultMessage } from "./types";
import type { MsgKey } from "./i18n";

export type ToolExecutionState = "preparing" | "pending" | "running" | "success" | "error" | "cancelled" | "unknown";
export interface ToolExecutionContext {
  running: boolean;
  continuing?: boolean;
  activeIds?: ReadonlySet<string>;
  preparingId?: string;
  cancelled?: boolean;
  runStartedAt?: number | null;
  toolStartedAt?: ReadonlyMap<string, number>;
  revealRequest?: { id: string; nonce: number };
}

export function toolExecutionState(id: string, result?: ToolResultMessage, context?: ToolExecutionContext): ToolExecutionState {
  // An empty successful result is still a result. Missing output is not success.
  if (result) return result.isError ? "error" : "success";
  if (context?.cancelled) return "cancelled";
  if (context?.activeIds?.has(id)) return "running";
  if (context?.preparingId === id) return "preparing";
  return context?.running ? "pending" : "unknown";
}

export function toolGroupState(states: ToolExecutionState[]): ToolExecutionState {
  for (const state of ["running", "preparing", "pending", "error", "unknown", "cancelled"] as const) {
    if (states.includes(state)) return state;
  }
  return states.length > 0 ? "success" : "unknown";
}

export const toolStateLabel: Record<ToolExecutionState, MsgKey> = {
  preparing: "chat.speedTool", pending: "chat.toolPending", running: "chat.runningTool",
  success: "chat.workComplete", error: "chat.toolFailed", cancelled: "chat.toolCancelled", unknown: "chat.toolUnknown",
};

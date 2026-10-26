import type { AgentMessage } from "@/lib/types";
import type { AgentPhase } from "./use-agent-session-types";

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

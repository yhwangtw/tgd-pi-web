import { getAssistantFailure } from "@/lib/assistant-outcome";
import type { AssistantMessage } from "@/lib/types";

export function assistantModelKey(message: { provider?: string; model?: string }): string {
  return `${message.provider ?? ""}:${message.model ?? ""}`;
}

export function shouldShowAssistantModelLabel(previousKey: string | null, message: AssistantMessage): boolean {
  return previousKey === null
    || previousKey !== assistantModelKey(message)
    || getAssistantFailure(message) !== null;
}

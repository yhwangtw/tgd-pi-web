import { redactSensitiveText } from "./redaction";
import type { SessionInfo } from "./types";

/** Compact derived metadata, safe to include in the sidebar index. */
export function assistantFailure(value: unknown, at?: string): SessionInfo["lastAssistantError"] {
  const message = value as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
  if (message?.role !== "assistant" || message.stopReason !== "error") return null;
  return { message: redactSensitiveText(message.errorMessage?.trim() || "Model call failed").slice(0, 2000), ...(at ? { at } : {}) };
}

import { getAssistantFailure } from "./assistant-outcome";
import { redactSensitiveText } from "./redaction";
import type { SessionInfo } from "./types";

/** Compact derived metadata, safe to include in the sidebar index. */
export function assistantFailure(value: unknown, at?: string): SessionInfo["lastAssistantError"] {
  const message = value as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
  const failure = getAssistantFailure(message);
  if (!failure) return null;
  return { message: redactSensitiveText(failure).slice(0, 2000), ...(at ? { at } : {}) };
}

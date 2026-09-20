import { redactSensitiveText } from "./redaction";
import { classifyProviderError } from "./provider-recovery";

/** Provider JSON is diagnostic data, not user-facing copy. Never echo request ids in the summary. */
export function presentProviderError(errorMessage: string | undefined, fallback: string, labels = {
  unsupported_setting: "This model does not support the selected thinking level. Choose another level.",
  model_unavailable: "This model was rejected for the current connection. Choose another model or check account access.",
}): { summary: string; actionUrl: string | null; details: string | null } {
  const raw = errorMessage ? redactSensitiveText(errorMessage).trim() : "";
  if (!raw) return { summary: fallback, actionUrl: null, details: null };
  let message = raw.replace(/^\s*(?:error\s*)?\d{3}\s*[:\-]?\s*/i, "");
  // Gate size/depth: malformed or oversized provider payloads remain bounded plain text.
  for (let depth = 0; depth < 3 && message.length <= 65536 && message.startsWith("{"); depth++) {
    try {
      const parsed = JSON.parse(message);
      const nested = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
      if (typeof nested !== "string") break;
      message = nested.trim();
    } catch { break; }
  }
  const kind = classifyProviderError(message).kind;
  const url = message.match(/https?:\/\/[^\s<>"\\]+/i)?.[0]?.replace(/[),.;]+$/, "") ?? null;
  const concise = (url ? message.replace(url, "") : message)
    .replace(/\s+Request\s*id\s*:[\s\S]*$/i, "")
    .replace(/\s*(?:manage|update)\s+(?:your\s+)?billing\s+(?:here\s*)?:?\s*$/i, "")
    .replace(/\s+/g, " ").trim().replace(/[.:\-\s]+$/, "") || fallback;
  const summary = kind === "unsupported_setting" || kind === "model_unavailable"
    ? labels[kind]
    : concise.length > 240 ? `${concise.slice(0, 240)}…` : concise;
  return { summary, actionUrl: url, details: summary !== raw || url ? raw : null };
}

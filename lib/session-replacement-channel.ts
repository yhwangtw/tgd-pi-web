export interface SessionReplacementBroadcast {
  previousSessionId: string;
  newSessionId: string;
  cwd?: string;
  sessionFile?: string;
}

export interface SessionReplacementChannel {
  publish: (replacement: SessionReplacementBroadcast) => void;
  close: () => void;
}

const CHANNEL_NAME = "pi-session-replacements";
const STORAGE_KEY = "pi-session-replacement-event";

/**
 * Idle tabs intentionally do not keep an SSE stream open. Mirror server-side
 * session replacement events through a browser channel so every tab that is
 * displaying the outgoing session follows the same replacement.
 */
export function createSessionReplacementChannel(
  onReplacement: (replacement: SessionReplacementBroadcast) => void,
): SessionReplacementChannel {
  if (typeof window === "undefined") return { publish: () => {}, close: () => {} };

  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<SessionReplacementBroadcast>) => {
      if (event.data && typeof event.data.previousSessionId === "string" && typeof event.data.newSessionId === "string") {
        onReplacement(event.data);
      }
    };
    return {
      publish: (replacement) => channel.postMessage(replacement),
      close: () => channel.close(),
    };
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const replacement = JSON.parse(event.newValue) as SessionReplacementBroadcast;
      if (typeof replacement.previousSessionId === "string" && typeof replacement.newSessionId === "string") {
        onReplacement(replacement);
      }
    } catch {
      // Ignore malformed or unrelated storage events.
    }
  };
  window.addEventListener("storage", onStorage);
  return {
    publish: (replacement) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...replacement, nonce: crypto.randomUUID?.() ?? Date.now() }));
      } catch {
        // Private browsing can reject localStorage. The initiating tab still
        // has the authoritative SSE event, so this is a best-effort fallback.
      }
    },
    close: () => window.removeEventListener("storage", onStorage),
  };
}

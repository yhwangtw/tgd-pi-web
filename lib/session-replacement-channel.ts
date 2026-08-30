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
let publishingChannel: BroadcastChannel | null = null;

/**
 * Publish a replacement even when the initiating view is not connected to
 * the runtime SSE stream (for example, an idle session imported from a modal).
 * A dedicated sender channel also lets listeners in the same window receive
 * the event; their session-id guard makes duplicate SSE delivery idempotent.
 */
export function publishSessionReplacement(replacement: SessionReplacementBroadcast): void {
  if (typeof window === "undefined") return;

  if (typeof BroadcastChannel !== "undefined") {
    publishingChannel ??= new BroadcastChannel(CHANNEL_NAME);
    publishingChannel.postMessage(replacement);
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...replacement, nonce: crypto.randomUUID?.() ?? Date.now() }));
  } catch {
    // Private browsing can reject localStorage. The initiating view still
    // applies the replacement directly; this only affects other idle tabs.
  }
}

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
      publish: publishSessionReplacement,
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
    publish: publishSessionReplacement,
    close: () => window.removeEventListener("storage", onStorage),
  };
}

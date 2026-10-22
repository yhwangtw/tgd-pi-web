/** Negotiated SSE transport only; SDK events and completed messages stay native. */
export const AGENT_STREAM_DELTA_FORMAT = "delta-v1";

export interface AgentMessageDelta {
  type: "message_update_delta";
  format: "json-splice-v1";
  baseCursor: string;
  /** Offsets and lengths are JavaScript UTF-16 code units, including JSON escapes. */
  edits: Array<{ start: number; remove: number; insert: string }>;
  length: number;
}

interface WireEvent { type: string; [key: string]: unknown; }
interface WireRecord {
  id?: string;
  data: string;
  type?: string;
  delta?: { baseCursor: string; data: string };
}

const resetsMessage = new Set([
  "session_snapshot", "message_start", "message_end", "agent_start", "agent_end",
  "session_closed", "session_restart", "session_replaced",
]);

export function resetsAgentMessageDelta(type: string): boolean { return resetsMessage.has(type); }

/** An exact splice of immutable JSON preserves every SDK/provider field, not just text. */
export function createAgentMessageDelta(base: string, next: string, baseCursor: string): string {
  const edits: AgentMessageDelta["edits"] = [];
  let before = 0;
  let after = 0;
  while (before < base.length || after < next.length) {
    // Let the engine compare large equal spans in native string code rather
    // than looping through the entire growing response one character at a time.
    while (before + 1024 <= base.length && after + 1024 <= next.length
      && base.slice(before, before + 1024) === next.slice(after, after + 1024)) { before += 1024; after += 1024; }
    while (before < base.length && after < next.length && base.charCodeAt(before) === next.charCodeAt(after)) { before++; after++; }
    if (before === base.length && after === next.length) break;
    // A bounded unchanged anchor handles multiple copies of the SDK partial
    // message without a quadratic general-purpose text diff. If no anchor fits,
    // replace the remaining middle exactly; callers choose full JSON if smaller.
    let oldAnchor = -1;
    let newAnchor = -1;
    if (edits.length < 8) {
      const window = next.slice(after, after + 4096 + 32);
      for (let skip = 0; skip <= 64 && before + skip + 32 <= base.length; skip++) {
        const found = window.indexOf(base.slice(before + skip, before + skip + 32));
        if (found >= 0 && found <= 4096) { oldAnchor = before + skip; newAnchor = after + found; break; }
      }
    }
    if (oldAnchor >= 0) {
      edits.push({ start: before, remove: oldAnchor - before, insert: next.slice(after, newAnchor) });
      before = oldAnchor;
      after = newAnchor;
    } else {
      let suffix = 0;
      const shared = Math.min(base.length - before, next.length - after);
      while (suffix + 1024 <= shared
        && base.slice(base.length - suffix - 1024, base.length - suffix) === next.slice(next.length - suffix - 1024, next.length - suffix)) suffix += 1024;
      while (suffix < shared && base.charCodeAt(base.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) suffix++;
      edits.push({ start: before, remove: base.length - before - suffix, insert: next.slice(after, next.length - suffix) });
      break;
    }
  }
  const frame: AgentMessageDelta = {
    type: "message_update_delta", format: "json-splice-v1", baseCursor, edits, length: next.length,
  };
  return JSON.stringify(frame);
}

/** Each connection begins with a full update, including cursor replay connections. */
export class AgentStreamTransport {
  private baseCursor: string | null = null;
  constructor(private readonly deltas: boolean) {}

  select<T extends WireRecord>(record: T, type: string): T {
    const data = this.deltas && record.delta?.baseCursor === this.baseCursor ? record.delta.data : record.data;
    if (type === "message_update") this.baseCursor = record.id ?? null;
    else if (resetsAgentMessageDelta(type)) this.baseCursor = null;
    return data === record.data ? record : { ...record, data };
  }
}

function wireEvent(value: unknown): value is WireEvent {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as WireEvent).type === "string";
}

/**
 * One connection-local baseline. Invalid frames must trigger a cursorless snapshot
 * reconnect; callers must never acknowledge them or silently keep applying deltas.
 */
export class AgentStreamDecoder {
  private base: { cursor: string; data: string } | null = null;

  decode(frame: unknown, data: string, cursor: string): WireEvent {
    if (!wireEvent(frame)) throw new Error("Invalid agent stream event");
    if (frame.type === "message_update_delta") {
      const delta = frame as unknown as AgentMessageDelta;
      const base = this.base;
      if (delta.format !== "json-splice-v1" || !base || !cursor || delta.baseCursor !== base.cursor
        || !Array.isArray(delta.edits) || delta.edits.length > 16
        || !Number.isSafeInteger(delta.length) || delta.length < 0) {
        throw new Error("Agent stream delta requires a fresh snapshot");
      }
      let end = 0;
      let length = base.data.length;
      const parts: string[] = [];
      for (const edit of delta.edits) {
        if (!edit || !Number.isSafeInteger(edit.start) || edit.start < end || edit.start > base.data.length
          || !Number.isSafeInteger(edit.remove) || edit.remove < 0 || edit.remove > base.data.length - edit.start
          || typeof edit.insert !== "string") throw new Error("Invalid agent stream delta edit");
        parts.push(base.data.slice(end, edit.start), edit.insert);
        end = edit.start + edit.remove;
        length += edit.insert.length - edit.remove;
      }
      if (length !== delta.length) throw new Error("Invalid agent stream delta length");
      parts.push(base.data.slice(end));
      data = parts.join("");
      frame = JSON.parse(data) as unknown;
      if (!wireEvent(frame) || frame.type !== "message_update") throw new Error("Invalid reconstructed agent update");
    }
    // Store raw immutable JSON, not the event object a downstream handler can mutate.
    const event = frame as WireEvent;
    if (event.type === "message_update") this.base = cursor ? { cursor, data } : null;
    else if (resetsAgentMessageDelta(event.type)) this.base = null;
    return event;
  }
}

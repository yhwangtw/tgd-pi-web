import { randomUUID } from "node:crypto";
import { createAgentMessageDelta, resetsAgentMessageDelta } from "./agent-stream-wire";

/** type/delta are server-only metadata; data remains the immutable legacy payload. */
export interface AgentStreamRecord {
  id?: string;
  data: string;
  type?: string;
  delta?: { baseCursor: string; data: string };
}
export type ReplayStatus = "initial" | "replayed" | "reset";

/** Per-runtime, bounded, immutable wire records. Expired cursors use a snapshot. */
export class AgentEventLog {
  private sequence = 0;
  private bytes = 0;
  private messageBase: { cursor: string; data: string } | null = null;
  private readonly records: Array<AgentStreamRecord & { sequence: number; bytes: number }> = [];

  constructor(
    private readonly epoch: string = randomUUID(),
    private readonly maxEvents = 512,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {}

  get cursor(): string { return `${this.epoch}:${this.sequence}`; }

  append(event: unknown): AgentStreamRecord {
    const data = JSON.stringify(event);
    let bytes = Buffer.byteLength(data, "utf8");
    this.sequence += 1;
    const type = typeof event === "object" && event !== null && "type" in event && typeof event.type === "string" ? event.type : undefined;
    let delta: AgentStreamRecord["delta"];
    if (type === "message_update") {
      if (this.messageBase) {
        const compact = createAgentMessageDelta(this.messageBase.data, data, this.messageBase.cursor);
        const compactBytes = Buffer.byteLength(compact, "utf8");
        if (compactBytes < bytes) { delta = Object.freeze({ baseCursor: this.messageBase.cursor, data: compact }); bytes += compactBytes; }
      }
      // Do not retain a second unbounded baseline for an oversized single event.
      this.messageBase = bytes <= this.maxBytes ? { cursor: this.cursor, data } : null;
    } else if (type && resetsAgentMessageDelta(type)) this.messageBase = null;
    const record = { id: this.cursor, data, ...(type ? { type } : {}), ...(delta ? { delta } : {}), sequence: this.sequence, bytes };
    this.records.push(record);
    this.bytes += bytes;
    while (this.records.length > this.maxEvents || this.bytes > this.maxBytes) {
      const removed = this.records.shift()!;
      this.bytes -= removed.bytes;
      if (removed.id === this.messageBase?.cursor) this.messageBase = null;
    }
    return { id: record.id, data: record.data, ...(record.type ? { type: record.type } : {}), ...(record.delta ? { delta: record.delta } : {}) };
  }

  replay(cursor: string | null): { status: ReplayStatus; records: AgentStreamRecord[] } {
    if (!cursor) return { status: "initial", records: [] };
    const separator = cursor.lastIndexOf(":");
    const epoch = cursor.slice(0, separator);
    const sequenceText = cursor.slice(separator + 1);
    const sequence = Number(sequenceText);
    const oldest = this.records[0]?.sequence ?? this.sequence + 1;
    if (separator < 0 || epoch !== this.epoch || !/^\d+$/.test(sequenceText) || !Number.isSafeInteger(sequence)
      || sequence < oldest - 1 || sequence > this.sequence) {
      return { status: "reset", records: [] };
    }
    return {
      status: "replayed",
      records: this.records.filter((record) => record.sequence > sequence).map(({ id, data, type, delta }) => ({ id, data, ...(type ? { type } : {}), ...(delta ? { delta } : {}) })),
    };
  }
}

export function encodeAgentStreamRecord(record: AgentStreamRecord): string {
  return `${record.id ? `id: ${record.id}\n` : ""}data: ${record.data}\n\n`;
}

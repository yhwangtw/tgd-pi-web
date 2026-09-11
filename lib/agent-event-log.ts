import { randomUUID } from "node:crypto";

export interface AgentStreamRecord { id?: string; data: string; }
export type ReplayStatus = "initial" | "replayed" | "reset";

/** Per-runtime, bounded, immutable wire records. Expired cursors use a snapshot. */
export class AgentEventLog {
  private sequence = 0;
  private bytes = 0;
  private readonly records: Array<AgentStreamRecord & { sequence: number; bytes: number }> = [];

  constructor(
    private readonly epoch: string = randomUUID(),
    private readonly maxEvents = 512,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {}

  get cursor(): string { return `${this.epoch}:${this.sequence}`; }

  append(event: unknown): AgentStreamRecord {
    const data = JSON.stringify(event);
    const bytes = Buffer.byteLength(data, "utf8");
    this.sequence += 1;
    const record = { id: this.cursor, data, sequence: this.sequence, bytes };
    this.records.push(record);
    this.bytes += bytes;
    while (this.records.length > this.maxEvents || this.bytes > this.maxBytes) {
      this.bytes -= this.records.shift()!.bytes;
    }
    return { id: record.id, data: record.data };
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
      records: this.records.filter((record) => record.sequence > sequence).map(({ id, data }) => ({ id, data })),
    };
  }
}

export function encodeAgentStreamRecord(record: AgentStreamRecord): string {
  return `${record.id ? `id: ${record.id}\n` : ""}data: ${record.data}\n\n`;
}

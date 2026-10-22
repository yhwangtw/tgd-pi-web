import { describe, expect, it } from "vitest";
import { AgentEventLog, encodeAgentStreamRecord } from "../agent-event-log";

describe("bounded agent event log", () => {
  it("bounds retained UTF-8 bytes, with reset when a full record no longer fits", () => {
    const log = new AgentEventLog("epoch", 10, 50);
    const initial = log.cursor;
    log.append({ type: "x", content: "中".repeat(20) });
    expect(log.replay(initial)).toEqual({ status: "reset", records: [] });
    expect(log.replay(log.cursor)).toEqual({ status: "replayed", records: [] });
  });

  it("retains immutable event types for routing without changing SSE payloads", () => {
    const log = new AgentEventLog("epoch");
    const event = { type: "message_update", message: { content: "large growing message" } };
    const record = log.append(event);
    event.type = "session_closed";
    expect(record.type).toBe("message_update");
    expect(log.replay("epoch:0").records).toEqual([record]);
    expect(encodeAgentStreamRecord(record)).toBe(`id: epoch:1\ndata: ${record.data}\n\n`);
    expect(JSON.parse(record.data).type).toBe("message_update");
  });

  it("counts compact metadata in the byte budget and does not retain an evicted baseline", () => {
    const first = { type: "message_update", message: { content: "x".repeat(1000) } };
    const second = { type: "message_update", message: { content: "x".repeat(1000) + "y" } };
    const nativeBytes = Buffer.byteLength(JSON.stringify(first)) + Buffer.byteLength(JSON.stringify(second));
    const log = new AgentEventLog("epoch", 10, nativeBytes);
    log.append(first);
    expect(log.append(second).delta).toBeDefined();
    // Two native events fit exactly; retaining their compact alternative must
    // still evict the first record instead of exceeding the configured budget.
    expect(log.replay("epoch:0").status).toBe("reset");
    log.append({ type: "other", payload: "z".repeat(1500) });
    expect(log.append(second).delta).toBeUndefined();
  });

  it("keeps oversized updates complete but does not cache their unbounded baseline", () => {
    const log = new AgentEventLog("epoch", 10, 100);
    const event = { type: "message_update", message: { content: "x".repeat(1000) } };
    expect(JSON.parse(log.append(event).data)).toEqual(event);
    expect(log.append({ ...event, finalMetadata: true }).delta).toBeUndefined();
    expect(log.replay("epoch:0").status).toBe("reset");
  });

  it("rejects future, malformed, negative and foreign cursors", () => {
    const log = new AgentEventLog("epoch");
    log.append({ type: "agent_start" });
    for (const cursor of ["epoch:2", "epoch:NaN", "epoch:-1", "foreign:0", "epoch:"]) {
      expect(log.replay(cursor).status, cursor).toBe("reset");
    }
  });
});

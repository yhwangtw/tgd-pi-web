import { describe, expect, it } from "vitest";
import { AgentEventLog } from "../agent-event-log";

describe("bounded agent event log", () => {
  it("bounds retained UTF-8 bytes, with reset when a full record no longer fits", () => {
    const log = new AgentEventLog("epoch", 10, 50);
    const initial = log.cursor;
    log.append({ type: "x", content: "中".repeat(20) });
    expect(log.replay(initial)).toEqual({ status: "reset", records: [] });
    expect(log.replay(log.cursor)).toEqual({ status: "replayed", records: [] });
  });

  it("rejects future, malformed, negative and foreign cursors", () => {
    const log = new AgentEventLog("epoch");
    log.append({ type: "agent_start" });
    for (const cursor of ["epoch:2", "epoch:NaN", "epoch:-1", "foreign:0", "epoch:"]) {
      expect(log.replay(cursor).status, cursor).toBe("reset");
    }
  });
});

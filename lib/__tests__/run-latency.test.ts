import { describe, expect, it } from "vitest";
import { RunLatencyTracker, type RunLatencyRecord } from "../run-latency";
const message = { role: "assistant", content: [{ type: "text", text: "private response" }] };
function setup() {
  let now = 0;
  const output: RunLatencyRecord[] = [];
  const tracker = new RunLatencyTracker(() => now, value => output.push(value));
  return { tracker, output, at: (time: number) => { now = time; }, last: () => output.at(-1)! };
}
describe("content-free run latency", () => {
  it("separates client delivery/DOM timings from the server's own monotonic clock", () => {
    const t = setup(); t.at(1000); t.tracker.begin("one");
    t.at(1050); t.tracker.requestSent("one");
    t.at(1060); t.tracker.record({ type: "run_timing", timingId: "one", stage: "provider_request", elapsedMs: 5 });
    t.at(1150); t.tracker.record({ type: "message_start", message: { ...message, content: [] } });
    t.at(1200); t.tracker.record({ type: "message_update", message });
    t.at(1204); t.tracker.committed(message);
    t.at(1600); t.tracker.record({ type: "agent_end", messages: [message] });
    expect(t.last()).toEqual({ timingId: "one", status: "completed", requestSentMs: 50, firstEventMs: 150,
      firstContentMs: 200, firstCommitMs: 204, displayLagMs: 4, completedMs: 600, server: { provider_request: 5 } });
    expect(JSON.stringify(t.output)).not.toContain("private response");
  });
  it("does not count an initial snapshot while connecting, but invalidates a resumed run", () => {
    const t = setup(); t.tracker.begin("one"); t.tracker.record({ type: "session_snapshot" });
    expect(t.last().status).toBe("running");
    t.tracker.requestSent("one"); t.at(40); t.tracker.record({ type: "connected" });
    t.tracker.record({ type: "message_update", message }); t.tracker.committed(message);
    expect(t.last()).toMatchObject({ status: "interrupted" });
    expect(t.last().firstContentMs).toBeUndefined();
  });
  it("accepts a final-message-only DOM commit and ignores thinking/tool-only first content", () => {
    const t = setup(); t.tracker.begin("one"); t.tracker.requestSent("one");
    t.tracker.record({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] } });
    t.tracker.committed(message); expect(t.last().firstContentMs).toBeUndefined();
    t.at(10); t.tracker.record({ type: "message_end", message });
    t.tracker.record({ type: "agent_end", messages: [message] });
    t.at(12); t.tracker.committed(message); expect(t.last().displayLagMs).toBe(2);
  });
  it("waits for assistant text to commit instead of counting a preceding thinking/user render", () => {
    const t = setup(); t.tracker.begin("one"); t.tracker.requestSent("one");
    t.at(10); t.tracker.record({ type: "message_update", message });
    t.at(11); t.tracker.committed({ role: "assistant", content: [{ type: "thinking", thinking: "still rendering" }] });
    t.tracker.committed({ role: "user", content: "sent" });
    expect(t.last().firstCommitMs).toBeUndefined();
    t.at(20); t.tracker.committed(message);
    expect(t.last().firstCommitMs).toBe(20);
    expect(t.last().displayLagMs).toBe(10);
  });
  it("rejects mismatched and malformed server measurements and repeated stage replay", () => {
    const t = setup(); t.tracker.begin("one");
    for (const event of [
      { timingId: "other", stage: "accepted", elapsedMs: 0 },
      { timingId: "one", stage: "payload", elapsedMs: 0 },
      { timingId: "one", stage: "accepted", elapsedMs: -1 },
      { timingId: "one", stage: "accepted", elapsedMs: Infinity },
    ]) t.tracker.record({ type: "run_timing", ...event });
    expect(t.last().server).toEqual({});
    t.tracker.record({ type: "run_timing", timingId: "one", stage: "accepted", elapsedMs: 0 });
    t.tracker.record({ type: "run_timing", timingId: "one", stage: "accepted", elapsedMs: 50 });
    expect(t.last().server).toEqual({ accepted: 0 });
  });
  it("distinguishes local cancellation from an unconfirmed stop after dispatch", () => {
    const t = setup(); t.tracker.begin("not-sent"); t.tracker.cancelPendingSend();
    expect(t.last().status).toBe("aborted");
    t.tracker.begin("sent"); t.tracker.requestSent("sent"); t.tracker.cancelPendingSend();
    expect(t.last().status).toBe("interrupted");
    t.tracker.begin("confirmed"); t.tracker.requestSent("confirmed");
    t.tracker.finish("aborted"); t.tracker.cancelPendingSend();
    expect(t.last().status).toBe("aborted");
  });
  it("invalidates interrupted traces and safely isolates replacement sends", () => {
    const t = setup(); t.tracker.begin("one"); t.tracker.requestSent("one");
    t.at(20); t.tracker.begin("two"); t.tracker.requestSent("one");
    t.tracker.record({ type: "run_timing", timingId: "one", stage: "completed", elapsedMs: 20 });
    expect(t.last()).toEqual({ timingId: "two", status: "running", server: {} });
    t.tracker.finish("failed"); expect(t.last().status).toBe("failed");
    t.tracker.finish("completed"); expect(t.last().status).toBe("failed");
  });
});

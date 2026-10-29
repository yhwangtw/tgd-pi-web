import { describe, expect, it, vi } from "vitest";
import { RunLatencyServer, type RunTimingEvent } from "../run-latency-server";

const FIRST = "88deba82-f371-4f25-bd5d-cab39107d41f";
const SECOND = "06ef2648-aa0b-4b84-a25a-cad2188e73ec";

describe("server run latency observations", () => {
  it("emits only once per observed stage using elapsed monotonic time and stores no message data", () => {
    let now = 100;
    const events: RunTimingEvent[] = [];
    const trace = new RunLatencyServer(event => events.push(event), () => now);
    trace.accept(FIRST);
    now = 137.125; trace.mark("provider_request"); trace.mark("provider_request");
    now = 204.5;
    trace.observe({ type: "message_start", message: { role: "assistant", content: [] } });
    trace.observe({ type: "message_update", message: { role: "user", content: [{ type: "text", text: "private user input" }] } });
    trace.observe({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "private thought" }] } });
    trace.observe({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "private answer" }] } });
    now = 500; trace.observe({ type: "agent_end" }); trace.mark("provider_request"); trace.complete();
    expect(events).toEqual([
      { type: "run_timing", timingId: FIRST, stage: "accepted", elapsedMs: 0 },
      { type: "run_timing", timingId: FIRST, stage: "provider_request", elapsedMs: 37.13 },
      { type: "run_timing", timingId: FIRST, stage: "first_content", elapsedMs: 104.5 },
      { type: "run_timing", timingId: FIRST, stage: "completed", elapsedMs: 400 },
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("keeps one server trace through retry backoff and completes from the original acceptance clock", () => {
    let now = 1000;
    const events: RunTimingEvent[] = [];
    const trace = new RunLatencyServer(event => events.push(event), () => now);
    const token = trace.accept(FIRST)!;
    now = 1050; trace.mark("provider_request");
    now = 1100; trace.observe({ type: "agent_end", willRetry: true });
    expect(trace.isActive(token)).toBe(true);
    expect(trace.has("completed")).toBe(false);
    expect(trace.accept(SECOND)).toBeNull();
    expect(events.map(event => event.stage)).toEqual(["accepted", "provider_request"]);
    now = 1600; trace.observe({ type: "agent_start" }); trace.mark("provider_request");
    now = 1700; trace.observe({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }] } });
    now = 1900; trace.observe({ type: "agent_end", willRetry: false });
    expect(trace.isActive(token)).toBe(false);
    trace.observe({ type: "agent_end" }); trace.complete(token);
    expect(events).toEqual([
      { type: "run_timing", timingId: FIRST, stage: "accepted", elapsedMs: 0 },
      { type: "run_timing", timingId: FIRST, stage: "provider_request", elapsedMs: 50 },
      { type: "run_timing", timingId: FIRST, stage: "first_content", elapsedMs: 700 },
      { type: "run_timing", timingId: FIRST, stage: "completed", elapsedMs: 900 },
    ]);
  });

  it.each([undefined, null, "", "bad", "00000000-0000-0000-0000-000000000000", "88deba82-f371-4f25-bd5d-cab39107d41f extra"])("does no tracing/content inspection for invalid or absent UUID %j", id => {
    const emit = vi.fn(); const clock = vi.fn(() => 0);
    const trace = new RunLatencyServer(emit, clock);
    expect(trace.accept(id)).toBeNull();
    trace.mark("provider_request");
    trace.observe({ type: "message_update", get message() { throw new Error("must not inspect untraced output"); } });
    trace.complete();
    expect(emit).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
  });

  it("does not replace an active trace or let old async settlement complete a newer trace", () => {
    const emit = vi.fn(); const trace = new RunLatencyServer(emit);
    const first = trace.accept(FIRST)!;
    expect(trace.accept(SECOND)).toBeNull();
    trace.cancel(); const second = trace.accept(SECOND)!;
    trace.complete(first); trace.mark("provider_request"); trace.complete(second);
    expect(emit.mock.calls.map(([event]) => [event.timingId, event.stage])).toEqual([
      [FIRST, "accepted"], [SECOND, "accepted"], [SECOND, "provider_request"], [SECOND, "completed"],
    ]);
  });

  it.each(["message_start", "message_update", "message_end"])("recognizes tool-only host content at %s without serializing arguments", type => {
    const emit = vi.fn(); const trace = new RunLatencyServer(emit);
    trace.accept(FIRST);
    trace.observe({ type, message: { role: "assistant", content: [{ type: "toolCall", arguments: { toJSON() { throw new Error("private payload"); } } }] } });
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "first_content" }));
  });

  it("leaves unobserved stages absent and isolates diagnostics consumer errors", () => {
    const stages: string[] = []; const trace = new RunLatencyServer(event => { stages.push(event.stage); throw new Error("observer failed"); });
    expect(() => { trace.accept(FIRST); trace.complete(); }).not.toThrow();
    expect(stages).toEqual(["accepted", "completed"]);
  });
});

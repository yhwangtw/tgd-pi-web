import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  GENERATION_METRICS_ENTRY, ServerGenerationMetricsTracker, persistGenerationMetrics, readGenerationMetrics,
} from "../server-generation-metrics";
import { generationMessageKey, type GenerationMetrics } from "../generation-metrics";
import { buildSessionContext, buildSessionTranscript } from "../session-context";
import { createTaskResumeMessage, TASK_RESUME_ENTRY } from "../task-resume";
import { AgentSessionWrapper, type AgentEvent } from "../rpc-manager";
import type { AgentSessionLike } from "../pi-types";
import type { AssistantMessage, SessionEntry } from "../types";

const METRICS: GenerationMetrics = { tokens: 12, seconds: 0.25, estimated: false, source: "server", firstContentSeconds: 0.1 };
const answer = (text = "Saved answer", stopReason = "stop"): AssistantMessage => ({ role: "assistant", provider: "fixture",
  model: "offline", timestamp: 100, stopReason, content: [{ type: "text", text }],
  usage: { input: 10, output: 12, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
function clock() {
  let now = 0;
  return { tracker: new ServerGenerationMetricsTracker(() => now), at: (time: number) => { now = time; } };
}
function saved() {
  const manager = SessionManager.inMemory("/tmp/pi-generation-metrics-fixture");
  const user = manager.appendMessage({ role: "user", content: "Saved task", timestamp: 1 });
  const message = answer(); const id = manager.appendMessage(message as never);
  const key = generationMessageKey(message)!;
  return { manager, user, id, key, message, entries: () => manager.getEntries() as unknown as SessionEntry[] };
}
const wrappers: AgentSessionWrapper[] = [];
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.destroy(); vi.restoreAllMocks(); });

describe("server generation measurements", () => {
  it("includes provider wait and one buffered frame in a subsecond measurement", () => {
    const f = clock(); f.at(10); f.tracker.markProviderRequest();
    f.at(150); f.tracker.observe({ type: "message_start", message: { ...answer(), content: [] } });
    f.at(260);
    expect(f.tracker.observe({ type: "message_end", message: answer() })).toEqual({
      tokens: 12, seconds: 0.25, estimated: false, source: "server", firstContentSeconds: 0.25,
    });
  });

  it("uses SDK message_start as a fallback without claiming an unobserved request latency", () => {
    const f = clock(); f.tracker.observe({ type: "message_start", message: answer() }); f.at(25);
    expect(f.tracker.observe({ type: "message_end", message: answer() })).toEqual({ tokens: 12, seconds: 0.025, estimated: false, source: "server" });
  });

  it("can measure a complete end frame from an observed provider boundary without any updates", () => {
    const f = clock(); f.tracker.markProviderRequest(); f.at(40);
    expect(f.tracker.observe({ type: "message_end", message: answer() })).toMatchObject({ seconds: 0.04, firstContentSeconds: 0.04 });
    expect(f.tracker.observe({ type: "message_end", message: answer() })).toBeUndefined();
  });

  it.each(["error", "aborted"])("retains %s partial output as a measurement and estimates only visible text", stopReason => {
    const f = clock(); const message = { ...answer("VISIBLE_ONLY_1234", stopReason), usage: undefined,
      content: [{ type: "thinking", thinking: "private reasoning".repeat(20) }, { type: "text", text: "VISIBLE_ONLY_1234" },
        { type: "toolCall", name: "write", arguments: { content: "private arguments".repeat(20) } }],
    };
    f.tracker.markProviderRequest(); f.at(40); f.tracker.observe({ type: "message_start", message }); f.at(80);
    expect(f.tracker.observe({ type: "message_end", message })).toEqual({ tokens: 4, seconds: 0.08, estimated: true, source: "server", firstContentSeconds: 0.04 });
    expect(message.stopReason).toBe(stopReason);
  });

  it("prefers reliable provider usage for reasoning/tool-only output and invents no estimate when usage is absent", () => {
    const f = clock(); const message = { ...answer(), content: [{ type: "thinking", thinking: "private" }, { type: "toolCall", arguments: { text: "private" } }] };
    f.tracker.markProviderRequest(); f.at(50);
    expect(f.tracker.observe({ type: "message_end", message })).toMatchObject({ tokens: 12, estimated: false });
    f.tracker.markProviderRequest(); f.at(100);
    expect(f.tracker.observe({ type: "message_end", message: { ...message, usage: { output: 0 } } })).toBeUndefined();
  });

  it("starts each response separately and does not include time spent running a completed tool", () => {
    const f = clock(); f.tracker.markProviderRequest(); f.at(100);
    expect(f.tracker.observe({ type: "message_end", message: answer() })?.seconds).toBe(0.1);
    f.at(100_000); f.tracker.observe({ type: "message_end", message: { role: "toolResult" } });
    f.tracker.markProviderRequest(); f.at(100_050);
    expect(f.tracker.observe({ type: "message_end", message: answer("next") })?.seconds).toBe(0.05);
  });

  it("does not replace an active response start with a concurrent diagnostic marker", () => {
    const f = clock(); f.tracker.markProviderRequest(); f.at(20);
    f.tracker.observe({ type: "message_start", message: { ...answer(), content: [] } });
    f.at(80); f.tracker.markProviderRequest(); f.at(100);
    expect(f.tracker.observe({ type: "message_end", message: answer() })?.seconds).toBe(0.1);
  });

  it.each(["agent_end", "agent_start", "auto_retry_start", "compaction_start", "auto_compaction_start"])("drops incomplete timing at %s", type => {
    const f = clock(); f.tracker.markProviderRequest(); f.at(10);
    f.tracker.observe({ type: "message_start", message: answer() }); f.tracker.observe({ type }); f.at(100);
    expect(f.tracker.observe({ type: "message_end", message: answer() })).toBeUndefined();
  });

  it("does not fabricate timing without an observed start or a positive finite interval", () => {
    const f = clock(); expect(f.tracker.observe({ type: "message_end", message: answer() })).toBeUndefined();
    f.tracker.markProviderRequest(); expect(f.tracker.observe({ type: "message_end", message: answer() })).toBeUndefined();
    f.at(20); f.tracker.markProviderRequest(); f.at(10);
    expect(f.tracker.observe({ type: "message_end", message: answer() })).toBeUndefined();
  });
});

describe("branch-bound generation metadata", () => {
  it("adds one SDK metadata entry without changing source messages, transcript indices or model context", () => {
    const f = saved(); const before = buildSessionTranscript(f.entries());
    expect(persistGenerationMetrics(f.manager, f.user, f.key, METRICS)).toBe(true);
    const after = buildSessionTranscript(f.entries());
    expect(after.messages).toEqual(before.messages); expect(after.entryIds).toEqual(before.entryIds);
    expect(after.generationMetrics).toEqual({ [f.key]: METRICS });
    expect(f.manager.buildSessionContext().messages).toHaveLength(2);
    expect(JSON.stringify(f.manager.buildSessionContext())).not.toContain(GENERATION_METRICS_ENTRY);
    expect(buildSessionContext(f.entries()).messages).toEqual(before.messages);
    expect(f.message).not.toHaveProperty("generationMetrics");
    expect(persistGenerationMetrics(f.manager, f.user, f.key, METRICS)).toBe(false);
  });

  it("isolates sibling branches and survives compaction without adding metadata to model projection", () => {
    const f = saved(); persistGenerationMetrics(f.manager, f.user, f.key, METRICS);
    const measuredLeaf = f.manager.getLeafId()!;
    const compactionId = f.manager.appendCompaction("Compact the saved task", f.id, 1000);
    const compacted = buildSessionTranscript(f.entries(), compactionId);
    expect(compacted.generationMetrics).toEqual({ [f.key]: METRICS });
    expect(compacted.entryIds).toEqual([f.user, f.id, compactionId]);
    f.manager.branch(f.user); const sibling = f.manager.appendMessage(answer("Different branch") as never);
    expect(buildSessionTranscript(f.entries(), sibling).generationMetrics).toBeUndefined();
    expect(buildSessionTranscript(f.entries(), measuredLeaf).generationMetrics).toEqual({ [f.key]: METRICS });
    expect(buildSessionTranscript(f.entries(), f.id).generationMetrics).toBeUndefined();
    expect(buildSessionTranscript(f.entries(), null).generationMetrics).toBeUndefined();
  });

  it("invalidates metadata when the answer is edited in place, including its private thinking or tool arguments", () => {
    const f = saved(); persistGenerationMetrics(f.manager, f.user, f.key, METRICS);
    const entry = f.entries().find(entry => entry.id === f.id)!;
    if (entry.type !== "message" || entry.message.role !== "assistant") throw new Error("Expected fixture answer");
    entry.message.content.push({ type: "thinking", thinking: "Changed content" });
    expect(buildSessionTranscript(f.entries()).generationMetrics).toBeUndefined();
  });

  it.each(["wrong-parent", "changed-key", "later-entry", "branch-switched"])("refuses persistence after %s without moving the selected leaf", kind => {
    const f = saved(); let parent = f.user, key = f.key;
    if (kind === "wrong-parent") parent = "other-parent";
    if (kind === "changed-key") key = "changed-key";
    if (kind === "later-entry") f.manager.appendCustomEntry("unrelated", {});
    if (kind === "branch-switched") f.manager.branch(f.user);
    const leaf = f.manager.getLeafId();
    expect(persistGenerationMetrics(f.manager, parent, key, METRICS)).toBe(false);
    expect(f.manager.getLeafId()).toBe(leaf);
  });

  it.each([null, {}, { version: 2 }, { version: 1, metrics: { ...METRICS, source: "browser" } },
    { version: 1, metrics: { ...METRICS, seconds: 0 } }])("ignores malformed or nonauthoritative metadata %j", data => {
    const f = saved(); f.manager.appendCustomEntry(GENERATION_METRICS_ENTRY, { version: 1, entryId: f.id, key: f.key, ...data });
    expect(readGenerationMetrics(f.entries())).toEqual({});
  });

  it("keeps resume's latest saved assistant checkpoint independent of the metadata leaf", () => {
    const f = saved(); const message = f.manager.getBranch().at(-1)!;
    if (message.type !== "message" || message.message.role !== "assistant") throw new Error("Expected fixture answer");
    message.message.stopReason = "error";
    persistGenerationMetrics(f.manager, f.user, f.key, METRICS);
    expect(f.manager.getLeafId()).not.toBe(f.id);
    const resumed = createTaskResumeMessage(f.manager.getBranch(), "resume-after-metrics");
    expect(resumed).toMatchObject({ customType: TASK_RESUME_ENTRY, details: { sourceEntryId: f.id } });
    expect(resumed.content).toContain("Saved answer"); expect(resumed.content).not.toContain(GENERATION_METRICS_ENTRY);
  });
});

it("enriches only the Web event and appends metadata after the official assistant persistence boundary", async () => {
  const manager = SessionManager.inMemory("/tmp/pi-generation-metrics-boundary");
  const user = manager.appendMessage({ role: "user", content: "Saved task", timestamp: 1 });
  let emit: (event: AgentEvent) => void = () => {};
  const inner = { sessionId: "metrics-boundary", sessionFile: "", sessionManager: manager, isStreaming: true,
    isCompacting: false, agent: { state: {} }, subscribe: (listener: typeof emit) => { emit = listener; return () => {}; }, dispose: vi.fn(),
  } as unknown as AgentSessionLike;
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const wrapper = new AgentSessionWrapper(inner); wrappers.push(wrapper); wrapper.start();
  const events: AgentEvent[] = []; wrapper.onEvent(event => events.push(event as AgentEvent));
  emit({ type: "agent_start" }); wrapper.markProviderRequest();
  now.mockReturnValue(100); emit({ type: "message_start", message: { ...answer(), content: [] } });
  emit({ type: "message_update", message: answer() });
  now.mockReturnValue(250); const event = { type: "message_end", message: answer() }; emit(event);
  expect(manager.getLeafId()).toBe(user); expect(event).not.toHaveProperty("generationMetrics");
  manager.appendMessage(event.message as never); await Promise.resolve();
  expect(events.at(-1)).toMatchObject({ generationMetrics: METRICS });
  expect(manager.getBranch().at(-1)).toMatchObject({ type: "custom", customType: GENERATION_METRICS_ENTRY });
});

it.each(["idle", "compacting"])("does not measure %s auxiliary assistant traffic", async kind => {
  const manager = SessionManager.inMemory("/tmp/pi-generation-metrics-auxiliary");
  manager.appendMessage({ role: "user", content: "Saved task", timestamp: 1 });
  let emit: (event: AgentEvent) => void = () => {};
  const inner = { sessionId: "metrics-auxiliary", sessionFile: "", sessionManager: manager, isStreaming: false,
    isCompacting: false, agent: { state: {} }, subscribe: (listener: typeof emit) => { emit = listener; return () => {}; }, dispose: vi.fn(),
  };
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const wrapper = new AgentSessionWrapper(inner as unknown as AgentSessionLike); wrappers.push(wrapper); wrapper.start();
  const events: AgentEvent[] = []; wrapper.onEvent(event => events.push(event as AgentEvent));
  if (kind === "compacting") { emit({ type: "agent_start" }); inner.isCompacting = true; }
  wrapper.markProviderRequest(); emit({ type: "message_start", message: { ...answer(), content: [] } });
  now.mockReturnValue(100); emit({ type: "message_end", message: answer() });
  manager.appendMessage(answer() as never); await Promise.resolve();
  expect(events.find(event => event.type === "message_end")).not.toHaveProperty("generationMetrics");
  expect(manager.getBranch().some(entry => entry.type === "custom" && entry.customType === GENERATION_METRICS_ENTRY)).toBe(false);
});

it("does not append a late measurement after a public listener changes the selected branch", async () => {
  const f = saved(); let emit: (event: AgentEvent) => void = () => {};
  const inner = { sessionId: "metrics-branch-race", sessionFile: "", sessionManager: f.manager, isStreaming: true,
    isCompacting: false, agent: { state: {} }, subscribe: (listener: typeof emit) => { emit = listener; return () => {}; }, dispose: vi.fn(),
  } as unknown as AgentSessionLike;
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const wrapper = new AgentSessionWrapper(inner); wrappers.push(wrapper); wrapper.start();
  emit({ type: "agent_start" }); wrapper.markProviderRequest();
  emit({ type: "message_start", message: { ...answer(), content: [] } });
  now.mockReturnValue(100); const message = answer("New measured answer");
  emit({ type: "message_end", message }); f.manager.appendMessage(message as never);
  f.manager.branch(f.user); await Promise.resolve();
  expect(f.manager.getLeafId()).toBe(f.user);
  expect(f.manager.getEntries().some(entry => entry.type === "custom" && entry.customType === GENERATION_METRICS_ENTRY)).toBe(false);
});

it("keeps a visible one-character reply measurable when provider usage is absent", () => {
  const f = clock(); f.tracker.markProviderRequest(); f.at(50);
  expect(f.tracker.observe({ type: "message_end", message: { ...answer("a"), usage: undefined } })).toMatchObject({ tokens: 1, seconds: 0.05, estimated: true });
});

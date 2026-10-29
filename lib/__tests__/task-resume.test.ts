import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { AgentSessionWrapper, type AgentEvent } from "../rpc-manager";
import type { AgentSessionLike } from "../pi-types";
import { createTaskResumeMessage, TASK_RESUME_ENTRY } from "../task-resume";
import { sendAgentCommand } from "../agent-client";

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(async () => {}) }));
vi.mock("../git-snapshot", () => ({ createSnapshot: mocks.snapshot }));
const wrappers: AgentSessionWrapper[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.destroy()); vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.snapshot.mockReset(); });
const entry = (id: string, role: string, content: unknown, stopReason?: string) => ({
  id, parentId: id === "user" ? null : "user", type: "message", timestamp: new Date().toISOString(),
  message: { role, content, stopReason, timestamp: Date.now() },
}) as SessionEntry;
const saved = () => [entry("user", "user", [{ type: "text", text: "Original user task" }]),
  entry("failed", "assistant", [{ type: "text", text: "Visible partial answer" }, { type: "thinking", thinking: "PRIVATE" },
    { type: "toolCall", name: "write", arguments: { secret: "UNFINISHED_ARGS" } }], "error")];
function fixture() {
  let callback: (event: AgentEvent) => void = () => {};
  const entries = saved();
  const inner = {
    sessionId: "resume-fixture", sessionFile: "", isStreaming: false, isIdle: true, isCompacting: false,
    model: { provider: "offline", id: "fixture" }, agent: { state: {} }, dispose: vi.fn(),
    sessionManager: { getEntries: () => entries, getBranch: () => entries, getLeafId: () => entries.at(-1)!.id },
    subscribe: (listener: typeof callback) => { callback = listener; return vi.fn(); },
    sendCustomMessage: vi.fn(async () => {}), prompt: vi.fn(), navigateTree: vi.fn(), abort: vi.fn(async () => {}),
  };
  const wrapper = new AgentSessionWrapper(inner as unknown as AgentSessionLike, "/fixture"); wrappers.push(wrapper); wrapper.start();
  return { wrapper, inner, entries, emit: (event: AgentEvent) => callback(event) };
}

describe("manual task recovery", () => {
  it("recovers visible failed text without user replay, private thinking or unfinished tool args", () => {
    const result = createTaskResumeMessage(saved(), "request-1");
    expect(result).toMatchObject({ customType: TASK_RESUME_ENTRY, display: false, details: { requestId: "request-1", sourceEntryId: "failed" } });
    expect(result.content).toContain("Visible partial answer");
    expect(result.content).not.toMatch(/PRIVATE|UNFINISHED_ARGS|Original user task/);
    expect(result.content).toContain("read-only checks");
  });

  it("does not repeatedly copy failed text already carried in a prior recovery entry", () => {
    const entries = saved();
    const prior = createTaskResumeMessage(entries, "request-1");
    entries.push({ type: "custom_message", ...prior, id: "resume-1", parentId: "failed", timestamp: new Date().toISOString() });
    entries.push(entry("failed-2", "assistant", [{ type: "text", text: "Second partial" }], "aborted"));
    const result = createTaskResumeMessage(entries, "request-2");
    expect(result.content).toContain("Second partial");
    expect(result.content).not.toContain("Visible partial answer");
  });

  it.each(["length", "stop"])("accepts a %s output failure and leaves already-contextual text alone", reason => {
    const entries = [saved()[0], entry("failed", "assistant", reason === "length" ? [{ type: "text", text: "Visible partial answer" }] : [], reason)];
    expect(createTaskResumeMessage(entries, "request-1").content).not.toContain("Visible partial answer");
  });

  it("rejects an empty session and a stale recovery button on a completed answer", () => {
    expect(() => createTaskResumeMessage([], "r")).toThrow("no saved task");
    expect(() => createTaskResumeMessage([saved()[0], entry("complete", "assistant", [{ type: "text", text: "All done" }], "stop")], "r", true)).toThrow("already finished");
  });

  it("keeps resume's receipt stable on a lost transport acknowledgement", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { accepted: true } }) });
    vi.stubGlobal("fetch", fetch);
    const command: Record<string, unknown> = { type: "resume" };
    await sendAgentCommand("s", command); await sendAgentCommand("s", command);
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies[0].requestId).toMatch(/^[\w-]{36}$/);
    expect(bodies[1].requestId).toBe(bodies[0].requestId);
  });

  it("deduplicates simultaneous admissions and excludes a second distinct resume while preparing", async () => {
    const f = fixture(); let release!: () => void;
    mocks.snapshot.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const first = f.wrapper.send({ type: "resume", requestId: "same" });
    const duplicate = f.wrapper.send({ type: "resume", requestId: "same" });
    await expect(f.wrapper.send({ type: "resume", requestId: "other" })).rejects.toThrow("current activity");
    await expect(f.wrapper.send({ type: "prompt", message: "new" })).rejects.toThrow("recovery is already starting");
    release(); expect(await first).toEqual({ accepted: true }); expect(await duplicate).toEqual({ accepted: true });
    expect(f.inner.sendCustomMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ customType: TASK_RESUME_ENTRY }), { triggerTurn: true });
    expect(f.inner.prompt).not.toHaveBeenCalled(); expect(f.inner.navigateTree).not.toHaveBeenCalled();
  });

  it.each(["stop", "navigate"])("does not start a model after %s during preparation", async action => {
    const f = fixture(); let release!: () => void;
    mocks.snapshot.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = f.wrapper.send({ type: "resume", requestId: "pending" });
    const rejected = expect(pending).rejects.toThrow(action === "stop" ? "cancelled" : "conversation changed");
    if (action === "stop") await f.wrapper.send({ type: "abort" }); else f.entries.push(entry("new-user", "user", "Different task"));
    release(); await rejected; expect(f.inner.sendCustomMessage).not.toHaveBeenCalled();
  });

  it.each(["streaming", "compacting", "not-idle", "missing-model", "stale-leaf", "missing-receipt"])("rejects %s before invoking the SDK", async kind => {
    const f = fixture();
    if (kind === "streaming") f.inner.isStreaming = true;
    if (kind === "compacting") f.inner.isCompacting = true;
    if (kind === "not-idle") f.inner.isIdle = false;
    if (kind === "missing-model") Object.assign(f.inner, { model: undefined });
    await expect(f.wrapper.send({ type: "resume", ...(kind !== "missing-receipt" ? { requestId: "r" } : {}),
      ...(kind === "stale-leaf" ? { expectedLeafId: "old" } : {}) })).rejects.toThrow();
    expect(f.inner.sendCustomMessage).not.toHaveBeenCalled();
  });

  it("returns a persisted receipt after runtime reload without running the task again", async () => {
    const f = fixture();
    f.entries.push({ type: "custom_message", ...createTaskResumeMessage(f.entries, "old"), id: "resume", parentId: "failed", timestamp: new Date().toISOString() });
    expect(await f.wrapper.send({ type: "resume", requestId: "old" })).toEqual({ accepted: true });
    expect(f.inner.sendCustomMessage).not.toHaveBeenCalled();
  });

  it("reports a startup rejection as a terminal error instead of leaving the UI waiting", async () => {
    const f = fixture(); const events: AgentEvent[] = []; f.wrapper.onEvent(event => events.push(event as AgentEvent));
    f.inner.sendCustomMessage.mockRejectedValue(new Error("Auth unavailable"));
    await f.wrapper.send({ type: "resume", requestId: "bad-auth" }); await Promise.resolve();
    expect(events.findLast(event => event.type === "agent_end")).toMatchObject({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "Auth unavailable" }] });
  });
});

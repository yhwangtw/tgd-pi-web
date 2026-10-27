import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createOutputRecoveryExtension, prioritizeVisibleAnswer, OUTPUT_RECOVERY_ENTRY, ANSWER_RECOVERY_PROMPT } from "../output-recovery-extension";
import { emptyWorkflow, WORKFLOW_ENTRY } from "../workflow-state";

const model = { id: "offline", api: "openai-completions", provider: "fixture", reasoning: true, contextWindow: 32768, maxTokens: 64,
  thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null } } as ExtensionContext["model"];
function harness() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let entries: unknown[] = [];
  const ctx = { model, signal: new AbortController().signal, hasPendingMessages: () => false,
    sessionManager: { getBranch: () => entries } };
  const extension = createOutputRecoveryExtension();
  if (typeof extension === "function") throw new Error("Expected named extension");
  extension.factory({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx) as { entries?: Array<{ customType: string; display: boolean }>; continue?: boolean } | undefined;
  const frame = (text = "partial", output = 64, stopReason = "length", id = "part-1") => ({ outcome: "completed", continue: false,
    context: { pendingMessages: [] }, messageEntryId: id, message: { role: "assistant", model: "offline", provider: "fixture", stopReason,
      content: text ? [{ type: "text", text }] : [{ type: "thinking", thinking: "private" }], usage: { output } } });
  emit("before_agent_start");
  return { ctx, emit, frame, workflow: (goal: unknown) => { entries = [{ type: "custom", customType: WORKFLOW_ENTRY, data: { ...emptyWorkflow(), goal } }]; } };
}

describe("official output continuation boundary", () => {
  it("continues progressing capped chunks without a fixed two-call ceiling, as hidden custom messages", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      const result = h.emit("turn_end", h.frame(`part-${i}`, 64, "length", `e${i}`));
      expect(result).toMatchObject({ continue: true, entries: [{ customType: OUTPUT_RECOVERY_ENTRY, display: false }] });
    }
    expect(h.emit("turn_end", h.frame("done", 8, "stop", "done"))).toBeUndefined();
  });
  it("leaves context-clamped or premature length stops to official SDK recovery", () => {
    const h = harness();
    expect(h.emit("turn_end", h.frame("partial", 20))).toBeUndefined();
  });
  it("defers model mismatches and known context overflow to Pi", () => {
    const h = harness(), mismatch = h.frame(); mismatch.message.model = "other";
    expect(h.emit("turn_end", mismatch)).toBeUndefined();
    const overflow = h.frame(); overflow.message.usage = { input: 32768, cacheRead: 0, output: 0 } as typeof overflow.message.usage;
    expect(h.emit("turn_end", overflow)).toBeUndefined();
  });

  it("makes one focused answer attempt when reasoning consumed the whole output cap", () => {
    const h = harness();
    expect(h.emit("turn_end", h.frame(""))?.continue).toBe(true);
    expect(h.emit("before_provider_request", { payload: { model: "offline", reasoning_effort: "high", max_completion_tokens: 64, messages: [{ role: "user", content: ANSWER_RECOVERY_PROMPT }] } }))
      .toMatchObject({ reasoning_effort: "low", max_completion_tokens: 64 });
    expect(h.emit("turn_end", h.frame("", 64, "length", "empty-2"))).toBeUndefined();
  });
  it("does not spend the answer-first override on a compaction request", () => {
    const h = harness(); h.emit("turn_end", h.frame(""));
    expect(h.emit("before_provider_request", { payload: { model: "offline", reasoning_effort: "high", messages: [{ role: "user", content: `Summarize this context: ${ANSWER_RECOVERY_PROMPT}` }] } })).toBeUndefined();
    expect(h.emit("before_provider_request", { payload: { model: "offline", reasoning_effort: "high", messages: [{ role: "user", content: ANSWER_RECOVERY_PROMPT }] } })).toMatchObject({ reasoning_effort: "low" });
  });

  it("resets the per-request override and repetition tracking when user input takes priority", () => {
    const h = harness(); h.emit("turn_end", h.frame("")); h.emit("input");
    expect(h.emit("before_provider_request", { payload: { model: "offline", reasoning_effort: "high" } })).toBeUndefined();
    expect(h.emit("turn_end", h.frame(""))?.continue).toBe(true);
  });
  it("treats whitespace-only changes to the same answer chunk as no progress", () => {
    const h = harness(); expect(h.emit("turn_end", h.frame("Same answer"))?.continue).toBe(true);
    expect(h.emit("turn_end", h.frame("Same   answer", 64, "length", "part-2"))).toBeUndefined();
  });

  it("does not spin on repeated chunks or duplicate boundary events", () => {
    const h = harness(); expect(h.emit("turn_end", h.frame())?.continue).toBe(true);
    expect(h.emit("turn_end", h.frame())).toBeUndefined();
    expect(h.emit("turn_end", h.frame("partial", 64, "length", "part-2"))).toBeUndefined();
  });
  it.each(["aborted", "error", "queued", "already-continuing", "signal-aborted"])("does not recover over %s", kind => {
    const h = harness(), event = h.frame();
    if (kind === "queued") event.context.pendingMessages = [{}] as never[];
    else if (kind === "already-continuing") event.continue = true;
    else if (kind === "signal-aborted") h.ctx.signal = AbortSignal.abort();
    else event.outcome = kind;
    expect(h.emit("turn_end", event)).toBeUndefined();
  });
  it.each(["paused", "budget_limited", "token-cap", "run-cap", "cleared"])("respects an explicit %s Goal", reason => {
    const h = harness(), goal = { id: "g", objective: "Answer", status: "active", tokens: 10, tokenBudget: 20, automaticRuns: 0, automaticRunLimit: 2 };
    h.workflow(goal); h.emit("before_agent_start");
    if (reason === "token-cap") goal.tokens = 20;
    else if (reason === "run-cap") goal.automaticRuns = 2;
    else goal.status = reason;
    h.workflow(reason === "cleared" ? null : goal);
    expect(h.emit("turn_end", h.frame())).toBeUndefined();
  });
});

describe("answer-first provider request", () => {
  it("changes only supported reasoning on that request, preserving caps and saved configuration", () => {
    const payload = { model: "offline", max_output_tokens: 64, reasoning: { effort: "high", summary: "auto" } };
    expect(prioritizeVisibleAnswer(payload, model)).toEqual({ ...payload, reasoning: { effort: "low", summary: "auto" } });
    expect(payload.reasoning.effort).toBe("high");
    expect(model?.thinkingLevelMap?.off).toBeNull();
  });
  it("does not invent provider fields, force unsupported off, or change a differently routed model", () => {
    expect(prioritizeVisibleAnswer({ model: "offline" }, model)).toBeUndefined();
    expect(prioritizeVisibleAnswer({ model: "other", reasoning_effort: "high" }, model)).toBeUndefined();
    expect(prioritizeVisibleAnswer({ model: "offline", reasoning_effort: "none" }, model)).toBeUndefined();
  });
});

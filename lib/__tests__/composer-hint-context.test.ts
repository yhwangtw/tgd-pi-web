import { describe, expect, it } from "vitest";
import { buildComposerHintContext, isHintContext, summarizeHintWorkflow } from "../composer-hint-context";
import { isComposerHintRequest } from "../composer-hints";
import type { AgentMessage } from "../types";

const user = (content: string): AgentMessage => ({ role: "user", content });
const assistant = (text: string): AgentMessage => ({ role: "assistant", model: "one", provider: "fixture", content: [{ type: "text", text }] });
const shell = (exitCode: number, command = "npm test"): AgentMessage => ({ role: "bashExecution", command, exitCode, output: "PRIVATE RAW OUTPUT" });
describe("bounded task-aware hint context", () => {
  it("retains an earlier user goal and recent corrections beyond the latest exchange", () => {
    const context = buildComposerHintContext([user("修正手機版輸入框，保留原本風格。"), ...Array.from({ length: 12 }, (_, i) => assistant(`Update ${i}`)), user("改成先檢查鍵盤操作，不要部署。"), assistant("已完成")]);
    expect(context.earlierGoal).toContain("保留原本風格");
    expect(context.corrections.at(-1)).toContain("不要部署");
    expect(isHintContext(context)).toBe(true);
  });
  it("reports execution failure despite an assistant success claim, without sending raw output", () => {
    const context = buildComposerHintContext([user("Fix layout"), shell(1), assistant("All passed")]);
    expect(context.evidence).toEqual([{ id: "e0", kind: "test", outcome: "failed" }]);
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  });
  it("reconciles a recovered command and excludes evidence preceding the latest user turn", () => {
    const messages = [user("Fix layout"), shell(1), shell(0), assistant("Fixed")];
    expect(buildComposerHintContext(messages).evidence).toEqual([{ id: "e1", kind: "test", outcome: "succeeded" }]);
    expect(buildComposerHintContext([...messages, user("Explain the result"), assistant("Here it is")]).evidence).toEqual([]);
  });
  it("treats unverified success prose as unknown and never forwards commands or secrets", () => {
    const messages: AgentMessage[] = [user("Inspect preview api_key=abc123 and keep the style"),
      { role: "assistant", model: "one", provider: "fixture", content: [{ type: "toolCall", toolCallId: "c", toolName: "bash", input: { command: "npm test --api-key=SECRET" } }] },
      { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "All tests passed SECRET" }] }, assistant("Done")];
    const context = buildComposerHintContext(messages);
    expect(context.evidence[0]).toMatchObject({ kind: "test", outcome: "unknown" });
    expect(JSON.stringify(context)).not.toMatch(/SECRET|abc123|npm test/);
    expect(context.earlierGoal).toContain("[REDACTED]");
  });
  it("reads current Goal/Plan UI without treating absent terminal cards as completion", () => {
    const context = buildComposerHintContext([], { statuses: { Goal: "paused · 0 tokens", Plan: "ready · 1/2" },
      widgets: { Goal: { lines: ["修復版面", "Session reopened"] }, Plan: { lines: ["驗證計畫", "✓ 1. 修復版面", "○ 2. 驗證手機", "/plan exit"] } } }, true);
    expect(context.workflow.goal?.status).toBe("paused");
    expect(context.workflow.plan?.steps[0]).toMatchObject({ text: "驗證手機", status: "pending" });
    expect(context.planningOnly).toBe(true);
    expect(buildComposerHintContext([]).workflow).toEqual({});
  });
  it("bounds long goals, corrections and workflow while preserving unfinished steps", () => {
    const context = buildComposerHintContext(Array.from({ length: 2000 }, () => user("不要" + "x".repeat(5000))));
    context.workflow = summarizeHintWorkflow({ version: 1, goal: { id: "g", objective: "g".repeat(4000), status: "complete", tokens: 0, automaticRuns: 0 }, plan: { title: "p".repeat(500), status: "executing", previousTools: [],
      steps: Array.from({ length: 30 }, (_, i) => ({ text: "step".repeat(200), status: i === 29 ? "pending" : "completed" })) } });
    expect(context.workflow.plan?.steps[0].id).toBe("plan29");
    expect(JSON.stringify(context).length).toBeLessThan(3000);
    expect(isHintContext(context)).toBe(true);
  });
  it("rejects unbounded and malformed optional hint data before model use", () => {
    const base = { provider: "fixture", modelId: "one", locale: "en", messages: [{ role: "user", text: "Fix" }, { role: "assistant", text: "Fixed" }] };
    expect(isComposerHintRequest({ ...base, context: buildComposerHintContext([]), sessionId: "dw_group_1" })).toBe(true);
    for (const extra of [{ context: {} }, { context: { ...buildComposerHintContext([]), planningOnly: "yes" } }, { excluded: Array(4).fill("No") }, { sessionId: "../private" }]) expect(isComposerHintRequest({ ...base, ...extra })).toBe(false);
  });
});

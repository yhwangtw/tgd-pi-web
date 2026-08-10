import { describe, expect, it } from "vitest";
import { buildAgentRunReport } from "../agent-run-report";
import type { AgentMessage } from "../types";

describe("buildAgentRunReport", () => {
  it("summarizes output, edits, tests, tools, usage, and duration", () => {
    const messages: AgentMessage[] = [{
      role: "assistant", provider: "p", model: "m", content: [
        { type: "toolCall", toolCallId: "1", toolName: "edit", input: { path: "src/a.ts" } },
        { type: "text", text: "Implemented the fix." },
      ],
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
    }, { role: "bashExecution", command: "npm test", output: "ok", exitCode: 0 }];
    expect(buildAgentRunReport(messages, "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:02.000Z")).toMatchObject({
      summary: "Implemented the fix.", changedFiles: ["src/a.ts"], durationMs: 2000,
      usage: { inputTokens: 13, outputTokens: 5, cost: 0.02 },
      tests: [{ name: "npm test", status: "passed" }],
    });
  });
});

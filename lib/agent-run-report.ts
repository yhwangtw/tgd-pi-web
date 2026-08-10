import type { AgentMessage, AssistantMessage } from "./types";
import type { AgentRunReport } from "./agent-run-types";

function textOf(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.type === "text" ? block.text : "")
    .join("\n")
    .trim();
}

function pathFrom(input: Record<string, unknown>): string | null {
  for (const key of ["path", "filePath", "file_path", "target", "filename"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function buildAgentRunReport(
  messages: AgentMessage[],
  startedAt?: string,
  finishedAt = new Date().toISOString(),
): AgentRunReport {
  const changedFiles = new Set<string>();
  const tools = new Set<string>();
  const tests: AgentRunReport["tests"] = [];
  let summary = "";
  let cost = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const message of messages) {
    if (message.role === "assistant") {
      const candidate = textOf(message);
      if (candidate) summary = candidate;
      if (message.usage) {
        cost += message.usage.cost.total;
        inputTokens += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
        outputTokens += message.usage.output;
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type !== "toolCall") continue;
        tools.add(block.toolName);
        if (/^(edit|write|apply_patch)$/i.test(block.toolName)) {
          const path = pathFrom(block.input);
          if (path) changedFiles.add(path);
        }
        if (/^(test|vitest|jest|pytest)$/i.test(block.toolName)) {
          tests.push({ name: String(block.input.command ?? block.toolName), status: "run" });
        }
      }
    } else if (message.role === "bashExecution") {
      if (/\b(test|vitest|jest|pytest|playwright|tsc|eslint)\b/i.test(message.command)) {
        tests.push({
          name: message.command.slice(0, 160),
          status: message.exitCode === 0 ? "passed" : message.exitCode == null ? "run" : "failed",
        });
      }
    }
  }

  const clippedSummary = summary.length > 900 ? `${summary.slice(0, 897)}…` : summary;
  return {
    summary: clippedSummary || "Run completed without a text summary.",
    changedFiles: [...changedFiles].slice(0, 100),
    tests: tests.slice(-30),
    tools: [...tools],
    usage: { inputTokens, outputTokens, cost },
    durationMs: startedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
  };
}

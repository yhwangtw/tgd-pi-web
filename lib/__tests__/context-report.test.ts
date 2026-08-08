import { describe, expect, it } from "vitest";
import type { AgentSessionLike } from "../pi-types";
import { buildContextReport } from "../context-report";

describe("buildContextReport", () => {
  it("reports effective instructions and resource activation", () => {
    const session = {
      sessionId: "session-1",
      cwd: "/workspace/repo",
      model: { provider: "openai", id: "gpt-test" },
      agent: { state: { systemPrompt: "effective prompt" } },
      sessionManager: { getCwd: () => "/workspace/repo" },
      settingsManager: { isProjectTrusted: () => true },
      getContextUsage: () => ({ percent: 25, contextWindow: 1000, tokens: 250 }),
      getActiveToolNames: () => ["read"],
      getAllTools: () => [
        { name: "read", description: "Read files" },
        { name: "write", description: "Write files" },
      ],
      resourceLoader: {
        getAgentsFiles: () => ({ agentsFiles: [{ path: "/workspace/AGENTS.md", content: "# Rules\nBe concise" }] }),
        getSystemPrompt: () => "base prompt",
        getSystemPromptSource: () => ({ path: "/workspace/SYSTEM.md" }),
        getAppendSystemPrompt: () => ["append prompt"],
        getAppendSystemPromptSources: () => [{ path: "/workspace/APPEND_SYSTEM.md" }],
        getSkills: () => ({ skills: [{
          name: "review",
          description: "Review code",
          filePath: "/workspace/.pi/skills/review/SKILL.md",
          disableModelInvocation: false,
          sourceInfo: { scope: "project", source: "auto" },
        }], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
      },
    } as unknown as AgentSessionLike;

    const report = buildContextReport(session, "/workspace/repo");
    expect(report.effectiveSystemPrompt).toBe("effective prompt");
    expect(report.sources.map((source) => source.kind)).toEqual(["agents", "system", "append"]);
    expect(report.skills[0]).toMatchObject({ name: "review", enabled: true, scope: "project" });
    expect(report.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "read", enabled: true }),
      expect.objectContaining({ name: "write", enabled: false }),
    ]));
  });
});

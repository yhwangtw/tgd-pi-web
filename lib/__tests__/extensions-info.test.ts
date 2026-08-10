import { describe, it, expect } from "vitest";
import {
  buildExtensionsReport,
  collectExtensionResources,
  displayExtensionSupport,
  type ExtensionLoadResultLike,
  type RunnerLike,
} from "../extensions-info";

describe("displayExtensionSupport", () => {
  it("shows unsupported surfaces as not applicable until an extension registers one", () => {
    expect(displayExtensionSupport("unsupported", 0)).toBe("notApplicable");
    expect(displayExtensionSupport("unsupported", 1)).toBe("unsupported");
    expect(displayExtensionSupport("partial", 0)).toBe("partial");
  });
});

function fakeRunner(overrides: Partial<RunnerLike> = {}): RunnerLike {
  return {
    getExtensionPaths: () => ["/home/u/.pi/agent/extensions/foo.ts"],
    getRegisteredCommands: () => [
      { name: "tgd-map", invocationName: "tgd-map", description: "Map the codebase", sourceInfo: { path: "/ext/tgd.ts" } },
    ],
    getAllRegisteredTools: () => [
      { definition: { name: "codegraph", description: "Query the code graph" }, sourceInfo: { path: "/ext/tgd.ts" } },
    ],
    getFlags: () => new Map([
      ["verbose", { name: "verbose", type: "boolean" as const, default: false, extensionPath: "/ext/tgd.ts" }],
    ]),
    getFlagValues: () => new Map<string, boolean | string>(),
    getCommandDiagnostics: () => [],
    getShortcutDiagnostics: () => [],
    ...overrides,
  };
}

describe("buildExtensionsReport", () => {
  it("serializes paths, commands, tools", () => {
    const r = buildExtensionsReport(fakeRunner());
    expect(r.paths).toEqual(["/home/u/.pi/agent/extensions/foo.ts"]);
    expect(r.commands[0]).toMatchObject({ name: "tgd-map", description: "Map the codebase", source: "/ext/tgd.ts" });
    expect(r.tools[0]).toMatchObject({ name: "codegraph", source: "/ext/tgd.ts" });
  });

  it("merges flag values over defaults", () => {
    const r = buildExtensionsReport(fakeRunner({
      getFlagValues: () => new Map<string, boolean | string>([["verbose", true]]),
    }));
    expect(r.flags[0]).toMatchObject({ name: "verbose", default: false, value: true });
  });

  it("falls back to the default when a flag has no explicit value", () => {
    const r = buildExtensionsReport(fakeRunner());
    expect(r.flags[0].value).toBe(false);
  });

  it("surfaces hard load failures as error diagnostics", () => {
    const r = buildExtensionsReport(fakeRunner(), [
      { path: "/ext/broken.js", error: "SyntaxError: Unexpected token" },
    ]);
    expect(r.diagnostics[0]).toMatchObject({
      type: "error",
      message: "SyntaxError: Unexpected token",
      path: "/ext/broken.js",
    });
  });

  it("dedupes diagnostics reported by both loaders", () => {
    const d = { type: "error" as const, message: "SyntaxError in foo.ts", path: "/ext/foo.ts" };
    const r = buildExtensionsReport(fakeRunner({
      getCommandDiagnostics: () => [d],
      getShortcutDiagnostics: () => [d, { type: "warning", message: "other", path: undefined }],
    }));
    expect(r.diagnostics).toHaveLength(2);
    expect(r.diagnostics[0]).toMatchObject({ type: "error", message: "SyntaxError in foo.ts" });
  });

  it("reports every observable extension registration surface", () => {
    const loadResult: ExtensionLoadResultLike = {
      errors: [],
      extensions: [{
        path: "/ext/full.ts",
        handlers: new Map([
          ["session_start", [() => undefined]],
          ["tool_call", [() => undefined, () => undefined]],
        ]),
        shortcuts: new Map([
          ["ctrl+g", { shortcut: "ctrl+g", description: "Go", extensionPath: "/ext/full.ts" }],
        ]),
        messageRenderers: new Map([["notice", () => ({})]]),
        entryRenderers: new Map([["checkpoint", () => ({})]]),
      }],
    };

    const r = buildExtensionsReport(fakeRunner(), {
      loadResult,
      providers: [{
        name: "team-ai",
        displayName: "Team AI",
        status: "registered",
        modelCount: 2,
        availableModelCount: 1,
        modelIds: ["team-fast", "team-large"],
        sources: ["/ext/full.ts"],
      }],
      resources: [
        { type: "skill", name: "team-review", path: "/ext/skills/review/SKILL.md", source: "extension:full" },
      ],
      runtimeDiagnostics: [
        { type: "error", message: "[register_provider] invalid model", path: "/ext/full.ts" },
      ],
    });

    expect(r.providers[0]).toMatchObject({ name: "team-ai", modelCount: 2, availableModelCount: 1 });
    expect(r.shortcuts[0]).toMatchObject({ shortcut: "ctrl+g", source: "/ext/full.ts" });
    expect(r.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "session_start", handlerCount: 1, source: "/ext/full.ts" }),
      expect.objectContaining({ name: "tool_call", handlerCount: 2, source: "/ext/full.ts" }),
    ]));
    expect(r.renderers).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "message", customType: "notice" }),
      expect.objectContaining({ type: "entry", customType: "checkpoint" }),
    ]));
    expect(r.resources[0]).toMatchObject({ type: "skill", name: "team-review" });
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ message: "[register_provider] invalid model" }));
    expect(r.compatibility).toMatchObject({
      providers: "supported",
      commands: "supported",
      tools: "supported",
      flags: "supported",
      commandContext: "supported",
      tuiUi: "partial",
      shortcuts: "partial",
      renderers: "partial",
    });
  });

  it("collects resources contributed by extensions only", () => {
    const resources = collectExtensionResources({
      getSkills: () => ({ skills: [
        { name: "ext-skill", filePath: "/ext/skill.md", sourceInfo: { source: "extension:full" } },
        { name: "user-skill", filePath: "/user/skill.md", sourceInfo: { source: "user" } },
      ] }),
      getPrompts: () => ({ prompts: [
        { name: "ext-prompt", filePath: "/ext/prompt.md", sourceInfo: { source: "extension:full" } },
      ] }),
      getThemes: () => ({ themes: [
        { name: "ext-theme", sourcePath: "/ext/theme.json", sourceInfo: { source: "extension:full" } },
      ] }),
    });

    expect(resources.map((r) => `${r.type}:${r.name}`)).toEqual([
      "skill:ext-skill",
      "prompt:ext-prompt",
      "theme:ext-theme",
    ]);
  });
});

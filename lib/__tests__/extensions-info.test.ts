import { describe, it, expect } from "vitest";
import {
  buildExtensionsReport,
  buildExtensionPermissionManifests,
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

describe("extension permission manifests", () => {
  it("separates observed registrations from unavoidable host-process potential", () => {
    const manifests = buildExtensionPermissionManifests({
      paths: ["<inline:guard>"],
      commands: [{ name: "guard", invocationName: "guard", source: "<inline:guard>" }],
      tools: [{ name: "safe_read", source: "<inline:guard>" }],
      flags: [],
      providers: [],
      shortcuts: [],
      events: [{ name: "tool_call", handlerCount: 2, source: "<inline:guard>" }],
      renderers: [],
      resources: [],
    }, "/work/project");

    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({ source: "<inline:guard>", scope: "runtime", origin: "inline" });
    expect(manifests[0].capabilities).toEqual(expect.arrayContaining([
      { id: "commands", evidence: "observed", count: 1 },
      { id: "agentTools", evidence: "observed", count: 1 },
      { id: "lifecycle", evidence: "observed", count: 2 },
      { id: "filesystem", evidence: "potential", count: 1 },
      { id: "process", evidence: "potential", count: 1 },
      { id: "network", evidence: "potential", count: 1 },
      { id: "credentials", evidence: "potential", count: 1 },
    ]));
  });

  it("marks project and installed package sources without claiming unobserved access", () => {
    const manifests = buildExtensionPermissionManifests({
      paths: ["/work/project/.pi/extensions/local.ts", "/Users/me/.pi/agent/npm/node_modules/pkg/index.ts"],
      commands: [], tools: [], flags: [], providers: [], shortcuts: [], events: [], renderers: [], resources: [],
    }, "/work/project");

    expect(manifests.find((item) => item.source.includes("local.ts"))).toMatchObject({ scope: "project", origin: "local" });
    expect(manifests.find((item) => item.source.includes("node_modules"))).toMatchObject({ scope: "user", origin: "package" });
    expect(manifests.every((item) => item.capabilities.every((capability) => capability.evidence === "potential"))).toBe(true);
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
    expect(r.permissions.length).toBeGreaterThan(0);
    expect(r.permissions.flatMap((permission) => permission.capabilities)).toContainEqual(
      expect.objectContaining({ id: "lifecycle", evidence: "observed" }),
    );
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

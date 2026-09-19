import { describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { createTrackedAgentServices } from "../pi-runtime";

vi.mock("../pi-model-runtime", () => ({
  createPiModelRuntime: vi.fn(async () => ({
    registerProvider: vi.fn(), unregisterProvider: vi.fn(),
    getModels: () => [], getAvailableSnapshot: () => [], getProvider: vi.fn(),
  })),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    getAgentDir: () => "/fixture/agent",
    initTheme: vi.fn(),
    ModelRegistry: class {},
    createAgentSessionServices: vi.fn(async () => ({
      agentDir: "/fixture/agent", settingsManager: { getTheme: () => "light" },
    })),
  };
});

describe("default Web tool execution", () => {
  it("constructs real built-in extensions without injecting an approval gate", async () => {
    await createTrackedAgentServices("/fixture/project");
    const options = vi.mocked(createAgentSessionServices).mock.calls.at(-1)![0]!;
    const extensions = options.resourceLoaderOptions!.extensionFactories!;
    const names = extensions.map(extension => typeof extension === "function" ? extension.name : extension.name);
    expect(names).toEqual(["Plan Mode", "Structured Output", "pi-web-mcp", "pi-web-subagent"]);
    expect(names).not.toContain("Safety Guard");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { durableModels } from "../durable-models";
import { openDurableAgentRun } from "../durable-agent-run";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Durable model compatibility bridge", () => {
  it("runs a real 1.0 Harness through the current coding agent ModelRuntime and 0.86 provider", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-durable-models-test-"));
    directories.push(directory);
    const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const faux = fauxProvider({ provider: "bridge-test", models: [{ id: "model" }], tokensPerSecond: 0 });
    runtime.registerNativeProvider(faux.provider as unknown as Parameters<typeof runtime.registerNativeProvider>[0]);
    faux.setResponses([fauxAssistantMessage("The current provider completed the Durable run")]);
    const handle = await openDurableAgentRun({
      id: "bridge-run", name: "Bridge", cwd: directory, prompt: "Test model compatibility",
      provider: "bridge-test", modelId: "model", toolNames: [],
      trigger: "manual", status: "running", createdAt: new Date().toISOString(),
    }, { directory, models: durableModels(runtime) });
    try {
      const result = await handle.run();
      expect(result.error).toBeUndefined();
      expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "The current provider completed the Durable run" }] });
      expect(faux.state.callCount).toBe(1);
    } finally { await handle.close(); }
  });
});

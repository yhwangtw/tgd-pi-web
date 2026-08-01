import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiModelRuntime } from "../pi-model-runtime";

describe("Pi model runtime", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("persists API-key login and logout through Pi's canonical runtime", async () => {
    // Auth persistence is the unit under test. Keep Pi's remote model catalog
    // out of this test so CI speed and registry availability cannot affect it.
    vi.stubEnv("PI_OFFLINE", "1");
    const agentDir = mkdtempSync(join(tmpdir(), "pi-web-model-runtime-"));
    tempDirs.push(agentDir);
    const notify = vi.fn();

    const runtime = await createPiModelRuntime({ agentDir });
    await runtime.login("openai", "api_key", {
      prompt: async () => "test-key",
      notify,
    });

    expect(runtime.getProviderAuthStatus("openai")).toMatchObject({ configured: true, source: "stored" });
    expect(notify).not.toHaveBeenCalled();

    const reloaded = await createPiModelRuntime({ agentDir });
    expect(reloaded.getProviderAuthStatus("openai")).toMatchObject({ configured: true, source: "stored" });

    await reloaded.logout("openai");
    const loggedOut = await createPiModelRuntime({ agentDir });
    expect(loggedOut.getProviderAuthStatus("openai").configured).toBe(false);
  });
});

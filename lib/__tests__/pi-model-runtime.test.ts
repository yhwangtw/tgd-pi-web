import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiModelRuntime } from "../pi-model-runtime";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

describe("Pi model runtime", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses the canonical auth file for shared OAuth refresh locks", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-web-shared-auth-")); tempDirs.push(root);
    const agentDir = join(root, "preview"); mkdirSync(agentDir);
    const shared = join(root, "auth.json"); writeFileSync(shared, "{}");
    symlinkSync(shared, join(agentDir, "auth.json"));
    const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue({} as ModelRuntime);
    await createPiModelRuntime({ agentDir });
    expect(create).toHaveBeenCalledWith({ authPath: realpathSync(shared), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
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

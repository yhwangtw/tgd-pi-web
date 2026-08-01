import { join } from "node:path";
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

interface PiModelRuntimeOptions {
  agentDir?: string;
  modelsPath?: string | null;
}

/**
 * Create Pi's canonical model/auth runtime without doing a startup network
 * catalog refresh. The runtime still reads the persisted auth.json and
 * models.json owned by Pi.
 */
export async function createPiModelRuntime(
  options: PiModelRuntimeOptions = {},
): Promise<ModelRuntime> {
  const agentDir = options.agentDir ?? getAgentDir();
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: options.modelsPath === undefined
      ? join(agentDir, "models.json")
      : options.modelsPath,
    allowModelNetwork: false,
  });
}

export async function createPiModelRegistry(
  options: PiModelRuntimeOptions = {},
): Promise<{ runtime: ModelRuntime; registry: ModelRegistry }> {
  const runtime = await createPiModelRuntime(options);
  return { runtime, registry: new ModelRegistry(runtime) };
}

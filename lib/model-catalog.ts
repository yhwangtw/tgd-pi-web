import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export interface CatalogModelLike {
  id: string;
  name: string;
  provider: string;
  thinkingLevelMap?: Record<string, string | null>;
}

export interface CatalogRegistryLike {
  getAvailable(): CatalogModelLike[];
}

export interface CatalogSettingsLike {
  getDefaultProvider(): string | null | undefined;
  getDefaultModel(): string | null | undefined;
}

export interface ModelCatalogSource {
  registry: CatalogRegistryLike;
  settings: CatalogSettingsLike;
  diagnostics: Array<{ type: string; message: string }>;
}

export interface ModelCatalogResponse {
  models: Record<string, string>;
  modelList: Array<{ id: string; name: string; provider: string }>;
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  diagnostics: Array<{ type: string; message: string }>;
}

export function resolveModelCatalogCwd(options: {
  method: "GET" | "POST";
  requestedCwd: string | null;
  sessionCwd: string | null;
}): string | null {
  if (options.method === "POST" && options.requestedCwd) return options.requestedCwd;
  return options.sessionCwd;
}

export function buildModelCatalog(
  registry: CatalogRegistryLike,
  settings: CatalogSettingsLike,
  diagnostics: ModelCatalogSource["diagnostics"] = [],
): ModelCatalogResponse {
  const available = registry.getAvailable();
  const models: Record<string, string> = {};
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  const modelList = available.map((model) => {
    const key = `${model.provider}:${model.id}`;
    models[key] = model.name;
    thinkingLevels[key] = getSupportedThinkingLevels(model as never);
    if (model.thinkingLevelMap) thinkingLevelMaps[key] = model.thinkingLevelMap;
    return { id: model.id, name: model.name, provider: model.provider };
  });

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const defaultMatch = defaultProvider
    ? available.find((model) => model.provider === defaultProvider && (!defaultModelId || model.id === defaultModelId))
    : undefined;
  const defaultModel = defaultProvider
    ? { provider: defaultProvider, modelId: defaultMatch?.id ?? defaultModelId ?? "" }
    : null;

  return { models, modelList, defaultModel, thinkingLevels, thinkingLevelMaps, diagnostics };
}

export async function resolveModelCatalogSource(options: {
  sessionId: string | null;
  cwd: string | null;
  getSessionSource: (sessionId: string) => ModelCatalogSource | null | Promise<ModelCatalogSource | null>;
  createCwdSource: (cwd: string) => Promise<ModelCatalogSource>;
}): Promise<ModelCatalogSource> {
  if (options.sessionId) {
    const active = await options.getSessionSource(options.sessionId);
    if (active) return active;
  }
  if (!options.cwd) throw new Error("cwd is required when no active session exists");
  return options.createCwdSource(options.cwd);
}

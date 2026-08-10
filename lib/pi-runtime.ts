import { join } from "node:path";
import { statSync } from "node:fs";
import {
  ModelRegistry,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  type AgentSessionServices,
  type ExtensionCommandContextActions,
  type ExtensionError,
  type ExtensionUIContext,
  type LoadExtensionsResult,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionProviderInfo } from "./extensions-info";
import { createPiModelRuntime } from "./pi-model-runtime";

interface ProviderModelLike {
  id: string;
  name: string;
  provider: string;
}

export interface TrackableModelRuntime {
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
  getModels(): readonly ProviderModelLike[];
  getAvailableSnapshot(): readonly ProviderModelLike[];
  getProvider(name: string): { name: string } | undefined;
}

interface TrackedProvider {
  sources: Set<string>;
  status: "registered" | "error";
  error?: string;
}

export class ExtensionProviderTracker {
  private readonly providers = new Map<string, TrackedProvider>();
  private reloadSeen: Set<string> | null = null;
  private reloadSources: Map<string, Set<string>> | null = null;

  constructor(private readonly runtime: TrackableModelRuntime) {}

  discover(name: string, source: string): void {
    if (this.reloadSeen) {
      this.reloadSeen.add(name);
      const sources = this.reloadSources?.get(name) ?? new Set<string>();
      sources.add(source);
      this.reloadSources?.set(name, sources);
    }
    const existing = this.providers.get(name);
    if (existing) {
      if (!this.reloadSeen) existing.sources.add(source);
      return;
    }
    this.providers.set(name, { sources: new Set([source]), status: "registered" });
  }

  registered(name: string): void {
    this.reloadSeen?.add(name);
    const existing = this.providers.get(name) ?? {
      sources: new Set(["<runtime>"]),
      status: "registered" as const,
    };
    existing.status = "registered";
    delete existing.error;
    this.providers.set(name, existing);
  }

  failed(name: string, error: unknown): void {
    this.reloadSeen?.add(name);
    const existing = this.providers.get(name) ?? {
      sources: new Set(["<runtime>"]),
      status: "error" as const,
    };
    existing.status = "error";
    existing.error = error instanceof Error ? error.message : String(error);
    this.providers.set(name, existing);
  }

  unregistered(name: string): void {
    this.providers.delete(name);
  }

  beginReload(): void {
    this.reloadSeen = new Set();
    this.reloadSources = new Map();
  }

  finishReload(): void {
    if (!this.reloadSeen) return;
    const seen = this.reloadSeen;
    const sources = this.reloadSources ?? new Map<string, Set<string>>();
    this.reloadSeen = null;
    this.reloadSources = null;

    for (const [name, tracked] of [...this.providers]) {
      if (seen.has(name)) {
        const currentSources = sources.get(name);
        if (currentSources?.size) tracked.sources = currentSources;
        if (tracked.status !== "error") continue;
      }
      this.runtime.unregisterProvider(name);
      if (seen.has(name) && tracked.status === "error") {
        this.providers.set(name, tracked);
      }
    }
  }

  abortReload(): void {
    this.reloadSeen = null;
    this.reloadSources = null;
  }

  snapshot(): ExtensionProviderInfo[] {
    const all = [...this.runtime.getModels()];
    const available = new Set(this.runtime.getAvailableSnapshot().map((model) => `${model.provider}:${model.id}`));
    return [...this.providers.entries()]
      .map(([name, tracked]) => {
        const models = all.filter((model) => model.provider === name);
        return {
          name,
          displayName: this.runtime.getProvider(name)?.name ?? name,
          status: tracked.status,
          modelCount: models.length,
          availableModelCount: models.filter((model) => available.has(`${name}:${model.id}`)).length,
          modelIds: models.map((model) => model.id).sort(),
          sources: [...tracked.sources].sort(),
          error: tracked.error,
        } satisfies ExtensionProviderInfo;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function trackExtensionProviders<T extends TrackableModelRuntime>(runtime: T): ExtensionProviderTracker {
  const tracker = new ExtensionProviderTracker(runtime);
  const registerProvider = runtime.registerProvider.bind(runtime);
  const unregisterProvider = runtime.unregisterProvider.bind(runtime);

  runtime.registerProvider = (name, config) => {
    try {
      registerProvider(name, config);
      tracker.registered(name);
    } catch (error) {
      tracker.failed(name, error);
      throw error;
    }
  };
  runtime.unregisterProvider = (name) => {
    unregisterProvider(name);
    tracker.unregistered(name);
  };
  return tracker;
}

export function initializeWebTheme(
  settings: { getTheme(): string | undefined },
  initialize: (themeName?: string, enableWatcher?: boolean) => void = initTheme,
): void {
  // SDK hosts do not initialize Pi's TUI theme automatically. Extensions can
  // still read ctx.ui.theme in RPC mode, so initialize the shared theme once
  // services have resolved the effective settings. A watcher is unnecessary
  // for the long-lived Web server and would leak across recreated services.
  initialize(settings.getTheme(), false);
}

interface ModelCatalogRefreshServices {
  agentDir: string;
  modelRuntime: {
    refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
  };
}

function modelsConfigVersion(agentDir: string): string | null {
  try {
    const stats = statSync(join(agentDir, "models.json"));
    return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
  } catch {
    return null;
  }
}

export function createAgentModelCatalogRefresher(
  services: ModelCatalogRefreshServices,
  readModelsVersion: () => string | null = () => modelsConfigVersion(services.agentDir),
): () => Promise<void> {
  let lastModelsVersion = readModelsVersion();
  return async () => {
    const nextModelsVersion = readModelsVersion();
    if (nextModelsVersion === lastModelsVersion) return;
    await services.modelRuntime.refresh({ allowNetwork: false });
    lastModelsVersion = nextModelsVersion;
  };
}

export async function createTrackedAgentServices(cwd: string): Promise<{
  services: AgentSessionServices;
  modelRegistry: ModelRegistry;
  providerTracker: ExtensionProviderTracker;
  refreshModelCatalog: () => Promise<void>;
}> {
  const agentDir = getAgentDir();
  const modelRuntime = await createPiModelRuntime({ agentDir });
  const providerTracker = trackExtensionProviders(modelRuntime);

  // Pi explicitly supports loading async provider factories without starting a
  // session (the same path used by `pi --list-models`). Keep model discovery on
  // that service path instead of constructing a bare ModelRegistry.
  // Source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#piregisterprovidername-config
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoaderOptions: {
      extensionsOverride(base: LoadExtensionsResult) {
        for (const registration of base.runtime.pendingProviderRegistrations) {
          providerTracker.discover(registration.name, registration.extensionPath);
        }
        return base;
      },
    },
  });
  initializeWebTheme(services.settingsManager);

  return {
    services,
    modelRegistry: new ModelRegistry(modelRuntime),
    providerTracker,
    refreshModelCatalog: createAgentModelCatalogRefresher(services),
  };
}

export async function bindWebExtensions(
  session: {
    bindExtensions(bindings: {
      mode: "rpc";
      uiContext: ExtensionUIContext;
      commandContextActions: ExtensionCommandContextActions;
      onError: (error: ExtensionError) => void;
    }): Promise<void>;
    waitForIdle(): Promise<void>;
    navigateTree(targetId: string, options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    }): Promise<{ cancelled: boolean }>;
    reload(): Promise<void>;
  },
  onError: (error: ExtensionError) => void,
  uiContext: ExtensionUIContext,
  runtimeActions: Partial<Pick<
    ExtensionCommandContextActions,
    "newSession" | "fork" | "switchSession"
  >> = {},
): Promise<void> {
  // SDK hosts must bind extensions after session creation. This emits
  // session_start and resources_discover and installs runtime error handling.
  // Source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
  const unsupported = (action: string) => async () => {
    throw new Error(`Extension command action "${action}" is not supported by Pi Web`);
  };
  const commandContextActions: ExtensionCommandContextActions = {
    waitForIdle: () => session.waitForIdle(),
    navigateTree: (targetId, options) => session.navigateTree(targetId, options),
    reload: () => session.reload(),
    newSession: runtimeActions.newSession ?? unsupported("newSession"),
    fork: runtimeActions.fork ?? unsupported("fork"),
    switchSession: runtimeActions.switchSession ?? unsupported("switchSession"),
  };
  await session.bindExtensions({ mode: "rpc", uiContext, commandContextActions, onError });
}

export async function emitWebBeforeFork(
  runner: {
    hasHandlers(event: "session_before_fork"): boolean;
    emit(event: { type: "session_before_fork"; entryId: string; position: "before" }): Promise<{ cancel?: boolean } | undefined>;
  } | undefined,
  entryId: string,
): Promise<boolean> {
  if (!runner?.hasHandlers("session_before_fork")) return true;
  const result = await runner.emit({
    type: "session_before_fork",
    entryId,
    position: "before",
  });
  return result?.cancel !== true;
}

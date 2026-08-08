import type { Api, AuthCheck, CredentialInfo, Model, Provider } from "@earendil-works/pi-ai";

export type ProviderHealthStatus = "ready" | "needs_auth" | "warning" | "invalid";

export interface ProviderHealthEntry {
  id: string;
  name: string;
  status: ProviderHealthStatus;
  authType?: "api_key" | "oauth";
  authSource?: string;
  configuredSource?: string;
  modelCount: number;
  availableModelCount: number;
  storedCredential: boolean;
  issue?: string;
}

export interface ProviderHealthReport {
  checkedAt: string;
  runtimeError?: string;
  summary: {
    total: number;
    ready: number;
    needsAuth: number;
    warning: number;
    invalid: number;
  };
  providers: ProviderHealthEntry[];
}

interface ProviderAuthStatus {
  configured: boolean;
  source?: string;
  label?: string;
}

export interface ProviderHealthRuntime {
  getProviders(): readonly Provider[];
  getModels(providerId?: string): readonly Model<Api>[];
  getAvailableSnapshot(): readonly Model<Api>[];
  getError(): string | undefined;
  getProviderAuthStatus(providerId: string): ProviderAuthStatus;
  checkAuth(providerId: string, options?: { signal?: AbortSignal }): Promise<AuthCheck | undefined>;
  listCredentials(options?: { signal?: AbortSignal }): Promise<readonly CredentialInfo[]>;
}

function statusRank(status: ProviderHealthStatus): number {
  if (status === "invalid") return 0;
  if (status === "warning") return 1;
  if (status === "ready") return 2;
  return 3;
}

export async function buildProviderHealthReport(
  runtime: ProviderHealthRuntime,
  options: { timeoutMs?: number; now?: () => Date } = {},
): Promise<ProviderHealthReport> {
  const timeoutMs = options.timeoutMs ?? 4_000;
  const credentials = await runtime.listCredentials({ signal: AbortSignal.timeout(timeoutMs) }).catch(() => []);
  const storedProviders = new Set(credentials.map((item) => item.providerId));
  const available = new Set(runtime.getAvailableSnapshot().map((model) => `${model.provider}:${model.id}`));
  const runtimeError = runtime.getError();

  const providers = await Promise.all(runtime.getProviders().map(async (provider) => {
    const models = runtime.getModels(provider.id);
    const configured = runtime.getProviderAuthStatus(provider.id);
    let auth: AuthCheck | undefined;
    let issue: string | undefined;

    try {
      auth = await runtime.checkAuth(provider.id, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      issue = error instanceof Error ? error.message : String(error);
    }

    const availableModelCount = models.filter((model) => available.has(`${model.provider}:${model.id}`)).length;
    let status: ProviderHealthStatus;
    if (issue || runtimeError) status = "invalid";
    else if (!auth && !configured.configured) status = "needs_auth";
    else if (models.length === 0 || availableModelCount === 0) status = "warning";
    else status = "ready";

    return {
      id: provider.id,
      name: provider.name,
      status,
      authType: auth?.type,
      authSource: auth?.source,
      configuredSource: configured.label ?? configured.source,
      modelCount: models.length,
      availableModelCount,
      storedCredential: storedProviders.has(provider.id),
      issue: issue ?? (runtimeError || undefined),
    } satisfies ProviderHealthEntry;
  }));

  providers.sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name));

  return {
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
    runtimeError,
    summary: {
      total: providers.length,
      ready: providers.filter((provider) => provider.status === "ready").length,
      needsAuth: providers.filter((provider) => provider.status === "needs_auth").length,
      warning: providers.filter((provider) => provider.status === "warning").length,
      invalid: providers.filter((provider) => provider.status === "invalid").length,
    },
    providers,
  };
}

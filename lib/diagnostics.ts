import { homedir } from "node:os";
import { collectAttentionItems } from "./attention-center";
import { getMcpStatuses, readMcpServers } from "./mcp";
import { createPiModelRuntime } from "./pi-model-runtime";
import { buildProviderHealthReport } from "./provider-health";
import { redactSensitiveValue } from "./redaction";
import { getRuntimeStatus } from "./runtime-status";
import { readSecurityActivityStore } from "./security-activity";

export interface DiagnosticsBundle {
  schemaVersion: 1;
  generatedAt: string;
  application: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
  runtime: Awaited<ReturnType<typeof getRuntimeStatus>>;
  providers: Awaited<ReturnType<typeof buildProviderHealthReport>>;
  mcp: Array<{
    id: string;
    name: string;
    enabled: boolean;
    scope: string;
    transport: string;
    state: string;
    toolCount: number;
    checkedAt?: string;
    error?: string;
  }>;
  recentAttention: Awaited<ReturnType<typeof collectAttentionItems>>;
  recentSecurityActivity: ReturnType<typeof readSecurityActivityStore>["entries"];
}

function maskPathText(value: string, home = homedir()): string {
  let output = value;
  if (home) output = output.split(home).join("~");
  output = output.replace(/\/Users\/[^/\s]+/g, "~");
  output = output.replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "~");
  return output;
}

export function sanitizeDiagnosticsValue<T>(value: T, home = homedir()): T {
  const redacted = redactSensitiveValue(value);
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return maskPathText(current, home);
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(Object.entries(current as Record<string, unknown>).map(([key, child]) => [key, visit(child)]));
  };
  return visit(redacted) as T;
}

export async function collectDiagnosticsBundle(): Promise<DiagnosticsBundle> {
  const [runtime, modelRuntime, servers, attention] = await Promise.all([
    getRuntimeStatus(),
    createPiModelRuntime(),
    readMcpServers(),
    collectAttentionItems(),
  ]);
  const providers = await buildProviderHealthReport(modelRuntime);
  const statusById = new Map(getMcpStatuses(servers).map((status) => [status.id, status]));
  const mcp = servers.map((server) => {
    const status = statusById.get(server.id);
    return {
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      scope: server.scope,
      transport: server.transport,
      state: status?.state ?? (server.enabled ? "connecting" : "disabled"),
      toolCount: status?.toolCount ?? 0,
      ...(status?.checkedAt ? { checkedAt: status.checkedAt } : {}),
      ...(status?.error ? { error: status.error } : {}),
    };
  });
  return sanitizeDiagnosticsValue({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    application: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    runtime,
    providers,
    mcp,
    recentAttention: attention.slice(0, 30),
    recentSecurityActivity: readSecurityActivityStore().entries.slice(0, 50),
  });
}

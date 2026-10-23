import { join } from "node:path";
import type { InlineExtension, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readAgentRunStore } from "./agent-run-store";
import { SubagentRpcClient } from "./upstream-subagent-rpc";

interface LivenessProvider { sessionId: string; isActive(): boolean }
interface UpstreamHost { sessionId: string; cwd: string; client: SubagentRpcClient }
interface HostState { hosts: Map<string, UpstreamHost>; providers: Set<LivenessProvider> }
const stateKey = Symbol.for("pi-web.upstream-subagents.v1");
const globals = globalThis as typeof globalThis & { [stateKey]?: HostState };
const state = globals[stateKey] ??= { hosts: new Map(), providers: new Set() };

// Public pi-subagents host protocol: keep the parent loaded while a child or
// completion wake is outstanding, including when no browser is subscribed.
const livenessKey = Symbol.for("@agegr/pi-web/session-liveness/v1");
const registries = globalThis as Record<symbol, unknown>;
registries[livenessKey] ??= {
  version: 1,
  register(provider: LivenessProvider) {
    state.providers.add(provider);
    return () => { state.providers.delete(provider); };
  },
};

export function hasUpstreamSubagentWork(sessionId: string): boolean {
  for (const provider of state.providers) {
    if (provider.sessionId !== sessionId) continue;
    try { if (provider.isActive()) return true; }
    catch { return true; } // A transient observer error must not evict live work.
  }
  return false;
}

export function listUpstreamSubagentHosts(): UpstreamHost[] { return [...state.hosts.values()]; }

/** Include the package's own guidance and prompt shortcuts without global installation. */
export function upstreamSubagentResources() {
  // Pi Web is launched from its application root (scripts/serve.mjs).
  const root = join(process.cwd(), "node_modules", "pi-subagents");
  return { additionalSkillPaths: [join(root, "skills")], additionalPromptTemplatePaths: [join(root, "prompts")] };
}

export function upstreamBudgetBlockReason(): string | undefined {
  const limits = readAgentRunStore().subagentLimits;
  if (limits && Object.values(limits).some(value => typeof value === "number" && value > 0)) {
    return "Saved Pi Web subagent limits cannot be enforced equivalently by pi-subagents. Review the existing limits before switching delegation engines; no limits have been removed.";
  }
}
const assertBudgetCompatibility = () => { const reason = upstreamBudgetBlockReason(); if (reason) throw new Error(reason); };
const READ_ACTIONS = new Set(["status", "list", "guide", "cost", "cancel", "stop", "interrupt", "transcript", "schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.delete"]);

/** Load the complete pinned community extension: lifecycle, tools, RPC and runners. */
export function createUpstreamSubagentExtension(): InlineExtension {
  return { name: "pi-subagents", factory: async pi => {
    assertBudgetCompatibility();
    const [{ default: register }, { registerSubagentCapabilityCeiling }] = await Promise.all([
      import("pi-subagents"), import("pi-subagents/capability-ceiling"),
    ]);
    let ceiling: ReturnType<typeof registerSubagentCapabilityCeiling> | undefined;
    let ceilingSession: string | undefined;
    const updateCeiling = (ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const value = { allowedTools: pi.getActiveTools().filter(name => /^[A-Za-z0-9_.:-]{1,128}$/.test(name)),
        ...(upstreamBudgetBlockReason() ? { allowedAgents: [] } : {}) };
      if (ceilingSession !== sessionId) { ceiling?.dispose(); ceiling = undefined; ceilingSession = sessionId; }
      if (ceiling) ceiling.update(value);
      else ceiling = registerSubagentCapabilityCeiling({ sessionId, source: "pi-web-parent-tools", ceiling: value });
    };
    // Keep the package's implementation intact; the host preserves its existing
    // budgets and tool selection at the boundary instead of cloning scheduling.
    const guarded = new Proxy(pi, { get(target, key, receiver) {
      if (key === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => target.registerTool({
        ...definition,
        execute: (...args) => {
          updateCeiling(args[4]);
          if (definition.name === "subagent" && !READ_ACTIONS.has(String((args[1] as Record<string, unknown>).action ?? ""))) assertBudgetCompatibility();
          return definition.execute(...args);
        },
      });
      if (key === "registerCommand") return (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => target.registerCommand(name, {
        ...command, handler: (args, ctx) => { updateCeiling(ctx); assertBudgetCompatibility(); return command.handler(args, ctx); },
      });
      return Reflect.get(target, key, receiver);
    } });
    const client = new SubagentRpcClient(pi.events, { timeoutMs: 10_000 });
    const request = client.request.bind(client);
    client.request = (method, params, options) => {
      if (["spawn", "resume", "manage", "steer"].includes(method)) assertBudgetCompatibility();
      return request(method, params, options);
    };
    try { register(guarded); } catch (error) { client.dispose(); throw error; }
    let host: UpstreamHost | undefined;
    pi.on("session_start", (_event, ctx) => {
      if (host && state.hosts.get(host.sessionId) === host) state.hosts.delete(host.sessionId);
      updateCeiling(ctx);
      host = { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, client };
      state.hosts.set(host.sessionId, host);
    });
    pi.on("before_agent_start", (_event, ctx) => { updateCeiling(ctx); });
    pi.on("session_shutdown", () => {
      ceiling?.dispose();
      if (host && state.hosts.get(host.sessionId) === host) state.hosts.delete(host.sessionId);
      client.dispose();
    });
  } };
}

// ============================================================================
// Serialize Pi's extension runtime into a JSON-safe inventory. The report is
// intentionally additive: existing paths/commands/tools/flags/diagnostics
// consumers keep working while newer Web surfaces can inspect every observable
// registration type and see which Pi TUI capabilities are unsupported here.
// ============================================================================

export interface ExtensionCommandInfo {
  name: string;
  invocationName: string;
  description?: string;
  source?: string;
}

export interface ExtensionToolInfo {
  name: string;
  description?: string;
  source?: string;
}

export interface ExtensionFlagInfo {
  name: string;
  description?: string;
  type: "boolean" | "string";
  default?: boolean | string;
  value?: boolean | string;
  source?: string;
}

export interface ExtensionDiagnosticInfo {
  type: "info" | "warning" | "error" | "collision";
  message: string;
  path?: string;
}

export interface ExtensionProviderInfo {
  name: string;
  displayName: string;
  status: "registered" | "error";
  modelCount: number;
  availableModelCount: number;
  modelIds: string[];
  sources: string[];
  error?: string;
}

export interface ExtensionShortcutInfo {
  shortcut: string;
  description?: string;
  source?: string;
}

export interface ExtensionEventInfo {
  name: string;
  handlerCount: number;
  source: string;
}

export interface ExtensionRendererInfo {
  type: "message" | "entry";
  customType: string;
  source: string;
}

export interface ExtensionResourceInfo {
  type: "skill" | "prompt" | "theme";
  name: string;
  path?: string;
  source: string;
}

export type ExtensionWebSupport = "supported" | "partial" | "unsupported";
export type ExtensionSupportDisplay = ExtensionWebSupport | "notApplicable";

export type ExtensionPermissionId =
  | "filesystem"
  | "process"
  | "network"
  | "credentials"
  | "agentTools"
  | "commands"
  | "providers"
  | "configuration"
  | "lifecycle"
  | "keyboard"
  | "display"
  | "instructions"
  | "appearance";

export interface ExtensionPermissionCapability {
  id: ExtensionPermissionId;
  evidence: "potential" | "observed";
  count: number;
}

export interface ExtensionPermissionManifest {
  source: string;
  scope: "runtime" | "project" | "user" | "unknown";
  origin: "inline" | "package" | "local" | "unknown";
  capabilities: ExtensionPermissionCapability[];
}

export function displayExtensionSupport(
  support: ExtensionWebSupport,
  registrationCount?: number,
): ExtensionSupportDisplay {
  return support === "unsupported" && registrationCount === 0 ? "notApplicable" : support;
}

export interface ExtensionsReport {
  paths: string[];
  commands: ExtensionCommandInfo[];
  tools: ExtensionToolInfo[];
  flags: ExtensionFlagInfo[];
  providers: ExtensionProviderInfo[];
  shortcuts: ExtensionShortcutInfo[];
  events: ExtensionEventInfo[];
  renderers: ExtensionRendererInfo[];
  resources: ExtensionResourceInfo[];
  permissions: ExtensionPermissionManifest[];
  diagnostics: ExtensionDiagnosticInfo[];
  runtime?: {
    state: "ready" | "replacing" | "failed" | "disposed";
    sessionId: string;
    sessionFile: string;
    cwd: string;
    connectedClients: number;
    replacementCount: number;
    pendingReplacement?: { reason: string; startedAt: string; previousSessionId: string };
    lastReplacement?: { reason: string; at: string; previousSessionId: string; nextSessionId: string; cwd: string };
    lastFailure?: { reason: string; at: string; message: string; recovered: boolean; recoveryError?: string };
  };
  compatibility: {
    providers: ExtensionWebSupport;
    commands: ExtensionWebSupport;
    tools: ExtensionWebSupport;
    flags: ExtensionWebSupport;
    commandContext: ExtensionWebSupport;
    shortcuts: ExtensionWebSupport;
    events: ExtensionWebSupport;
    renderers: ExtensionWebSupport;
    resources: ExtensionWebSupport;
    tuiUi: ExtensionWebSupport;
  };
}

export interface ExtensionLike {
  path: string;
  handlers: Map<string, unknown[]>;
  shortcuts: Map<string, { shortcut: string; description?: string; extensionPath?: string }>;
  messageRenderers: Map<string, unknown>;
  entryRenderers?: Map<string, unknown>;
}

export interface ExtensionLoadResultLike {
  extensions: ExtensionLike[];
  errors: Array<{ path: string; error: string }>;
}

export interface ResourceLoaderLike {
  getSkills(): { skills: Array<{ name: string; filePath?: string; sourceInfo?: { source?: string } }> };
  getPrompts(): { prompts: Array<{ name: string; filePath?: string; sourceInfo?: { source?: string } }> };
  getThemes(): { themes: Array<{ name?: string; sourcePath?: string; sourceInfo?: { source?: string } }> };
}

// The slice of Pi's ExtensionRunner this module reads. Structural, so tests can
// pass a plain object and the API route can pass the real runner.
export interface RunnerLike {
  getExtensionPaths(): string[];
  getRegisteredCommands(): Array<{
    name: string;
    invocationName: string;
    description?: string;
    sourceInfo?: { path?: string };
  }>;
  getAllRegisteredTools(): Array<{
    definition: { name: string; description?: string };
    sourceInfo?: { path?: string };
  }>;
  getFlags(): Map<string, {
    name: string;
    description?: string;
    type: "boolean" | "string";
    default?: boolean | string;
    extensionPath?: string;
  }>;
  getFlagValues(): Map<string, boolean | string>;
  getCommandDiagnostics(): Array<{ type: "warning" | "error" | "collision"; message: string; path?: string }>;
  getShortcutDiagnostics(): Array<{ type: "warning" | "error" | "collision"; message: string; path?: string }>;
}

export interface BuildExtensionsReportOptions {
  loadResult?: ExtensionLoadResultLike;
  providers?: ExtensionProviderInfo[];
  resources?: ExtensionResourceInfo[];
  runtimeDiagnostics?: ExtensionDiagnosticInfo[];
  runtime?: ExtensionsReport["runtime"];
}

interface PermissionInventory {
  paths: string[];
  commands: ExtensionCommandInfo[];
  tools: ExtensionToolInfo[];
  flags: ExtensionFlagInfo[];
  providers: ExtensionProviderInfo[];
  shortcuts: ExtensionShortcutInfo[];
  events: ExtensionEventInfo[];
  renderers: ExtensionRendererInfo[];
  resources: ExtensionResourceInfo[];
}

const UNKNOWN_EXTENSION_SOURCE = "<unknown extension>";

function permissionSourceScope(source: string, cwd?: string): ExtensionPermissionManifest["scope"] {
  if (source.startsWith("<inline:")) return "runtime";
  const normalized = source.replaceAll("\\", "/");
  const normalizedCwd = cwd?.replaceAll("\\", "/").replace(/\/$/, "");
  if (normalizedCwd && (normalized.startsWith(`${normalizedCwd}/.pi/`) || normalized.startsWith(`${normalizedCwd}/`))) {
    return "project";
  }
  if (normalized.includes("/.pi/agent/")) return "user";
  return "unknown";
}

function permissionSourceOrigin(source: string): ExtensionPermissionManifest["origin"] {
  if (source.startsWith("<inline:")) return "inline";
  const normalized = source.replaceAll("\\", "/");
  if (
    source.startsWith("npm:")
    || source.startsWith("git:")
    || normalized.includes("/node_modules/")
    || normalized.includes("/.pi/agent/npm/")
    || normalized.includes("/.pi/agent/git/")
    || normalized.includes("/.pi/npm/")
    || normalized.includes("/.pi/git/")
  ) return "package";
  if (source === UNKNOWN_EXTENSION_SOURCE) return "unknown";
  return "local";
}

/**
 * Pi extensions execute in the host process, so filesystem/process/network/
 * credential access is always possible even when it is not observable through
 * ExtensionRunner registrations. Registrations are reported separately as
 * observed capabilities rather than overstating static analysis certainty.
 */
export function buildExtensionPermissionManifests(
  inventory: PermissionInventory,
  cwd?: string,
): ExtensionPermissionManifest[] {
  const manifests = new Map<string, Map<string, ExtensionPermissionCapability>>();

  const ensure = (sourceValue?: string) => {
    const source = sourceValue?.trim() || UNKNOWN_EXTENSION_SOURCE;
    let capabilities = manifests.get(source);
    if (!capabilities) {
      capabilities = new Map();
      manifests.set(source, capabilities);
      for (const id of ["filesystem", "process", "network", "credentials"] as const) {
        capabilities.set(`potential:${id}`, { id, evidence: "potential", count: 1 });
      }
    }
    return { source, capabilities };
  };
  const observe = (source: string | undefined, id: ExtensionPermissionId, count = 1) => {
    const manifest = ensure(source);
    const key = `observed:${id}`;
    const existing = manifest.capabilities.get(key);
    manifest.capabilities.set(key, {
      id,
      evidence: "observed",
      count: (existing?.count ?? 0) + count,
    });
  };

  for (const path of inventory.paths) ensure(path);
  for (const command of inventory.commands) observe(command.source, "commands");
  for (const tool of inventory.tools) observe(tool.source, "agentTools");
  for (const flag of inventory.flags) observe(flag.source, "configuration");
  for (const provider of inventory.providers) {
    const sources = provider.sources.length > 0 ? provider.sources : [undefined];
    for (const source of sources) {
      observe(source, "providers");
      observe(source, "network");
    }
  }
  for (const shortcut of inventory.shortcuts) observe(shortcut.source, "keyboard");
  for (const event of inventory.events) observe(event.source, "lifecycle", event.handlerCount);
  for (const renderer of inventory.renderers) observe(renderer.source, "display");
  for (const resource of inventory.resources) {
    observe(resource.path ?? resource.source, resource.type === "theme" ? "appearance" : "instructions");
  }

  return [...manifests.entries()]
    .map(([source, capabilities]) => ({
      source,
      scope: permissionSourceScope(source, cwd),
      origin: permissionSourceOrigin(source),
      capabilities: [...capabilities.values()].sort((a, b) => (
        a.evidence === b.evidence ? a.id.localeCompare(b.id) : a.evidence === "observed" ? -1 : 1
      )),
    }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

export function collectExtensionResources(loader: ResourceLoaderLike): ExtensionResourceInfo[] {
  const resources: ExtensionResourceInfo[] = [];
  const add = (
    type: ExtensionResourceInfo["type"],
    item: { name?: string; filePath?: string; sourcePath?: string; sourceInfo?: { source?: string } },
  ) => {
    const source = item.sourceInfo?.source;
    if (!source?.startsWith("extension:")) return;
    resources.push({
      type,
      name: item.name ?? item.filePath ?? item.sourcePath ?? "unnamed",
      path: item.filePath ?? item.sourcePath,
      source,
    });
  };

  for (const skill of loader.getSkills().skills) add("skill", skill);
  for (const prompt of loader.getPrompts().prompts) add("prompt", prompt);
  for (const theme of loader.getThemes().themes) add("theme", theme);
  return resources;
}

export function buildExtensionsReport(
  runner: RunnerLike,
  optionsOrLoadErrors: BuildExtensionsReportOptions | Array<{ path: string; error: string }> = {},
): ExtensionsReport {
  // Preserve the old internal call shape while routes/tests migrate to options.
  const options: BuildExtensionsReportOptions = Array.isArray(optionsOrLoadErrors)
    ? { loadResult: { extensions: [], errors: optionsOrLoadErrors } }
    : optionsOrLoadErrors;
  const loadResult = options.loadResult ?? { extensions: [], errors: [] };
  const flagValues = runner.getFlagValues();
  const flags: ExtensionFlagInfo[] = [...runner.getFlags().values()].map((f) => ({
    name: f.name,
    description: f.description,
    type: f.type,
    default: f.default,
    value: flagValues.has(f.name) ? flagValues.get(f.name) : f.default,
    source: f.extensionPath,
  }));

  const shortcuts: ExtensionShortcutInfo[] = [];
  const events: ExtensionEventInfo[] = [];
  const renderers: ExtensionRendererInfo[] = [];
  for (const extension of loadResult.extensions) {
    for (const shortcut of extension.shortcuts.values()) {
      shortcuts.push({
        shortcut: shortcut.shortcut,
        description: shortcut.description,
        source: shortcut.extensionPath ?? extension.path,
      });
    }
    for (const [name, handlers] of extension.handlers) {
      events.push({ name, handlerCount: handlers.length, source: extension.path });
    }
    for (const customType of extension.messageRenderers.keys()) {
      renderers.push({ type: "message", customType, source: extension.path });
    }
    for (const customType of extension.entryRenderers?.keys() ?? []) {
      renderers.push({ type: "entry", customType, source: extension.path });
    }
  }

  // Command + shortcut diagnostics can overlap; runtime errors can repeat a
  // loader diagnostic. Keep the first occurrence of each exact issue.
  const seen = new Set<string>();
  const diagnostics: ExtensionDiagnosticInfo[] = [];
  const addDiagnostic = (d: ExtensionDiagnosticInfo) => {
    const key = `${d.type}|${d.message}|${d.path ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(d);
  };
  for (const e of loadResult.errors) {
    addDiagnostic({ type: "error", message: e.error, path: e.path });
  }
  for (const d of [...runner.getCommandDiagnostics(), ...runner.getShortcutDiagnostics()]) {
    addDiagnostic(d);
  }
  for (const d of options.runtimeDiagnostics ?? []) addDiagnostic(d);

  const paths = runner.getExtensionPaths();
  const commands = runner.getRegisteredCommands().map((c) => ({
    name: c.name,
    invocationName: c.invocationName,
    description: c.description,
    source: c.sourceInfo?.path,
  }));
  const tools = runner.getAllRegisteredTools().map((t) => ({
    name: t.definition.name,
    description: t.definition.description,
    source: t.sourceInfo?.path,
  }));
  const providers = options.providers ?? [];
  const resources = options.resources ?? [];
  const permissions = buildExtensionPermissionManifests({
    paths,
    commands,
    tools,
    flags,
    providers,
    shortcuts,
    events,
    renderers,
    resources,
  }, options.runtime?.cwd);

  return {
    paths,
    commands,
    tools,
    flags,
    providers,
    shortcuts,
    events,
    renderers,
    resources,
    permissions,
    diagnostics,
    ...(options.runtime ? { runtime: options.runtime } : {}),
    compatibility: {
      providers: "supported",
      commands: "supported",
      tools: "supported",
      flags: "supported",
      commandContext: "supported",
      shortcuts: "partial",
      events: "partial",
      renderers: "partial",
      resources: "partial",
      tuiUi: "partial",
    },
  };
}

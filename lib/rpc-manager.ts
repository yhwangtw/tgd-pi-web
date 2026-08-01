import { createAgentSessionFromServices, SessionManager, type ExtensionError, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { cacheSessionPath } from "./session-reader";
import { createSnapshot } from "./git-snapshot";
import type { AgentSessionLike, ToolInfo } from "./pi-types";
import { bindWebExtensions, createTrackedAgentServices, emitWebBeforeFork, type ExtensionProviderTracker } from "./pi-runtime";
import type { ExtensionDiagnosticInfo, ExtensionProviderInfo } from "./extensions-info";
import {
  ASK_USER_TOOL_NAME,
  WebExtensionUIBridge,
  createAskUserTool,
  withAskUserTool,
  type WebExtensionUIEvent,
  type WebExtensionUIResponse,
} from "./web-extension-ui";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent | WebExtensionUIEvent) => void;
type SessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  private authRefreshPending = false;
  private bashRunning = false;
  private readonly extensionDiagnostics: ExtensionDiagnosticInfo[];

  constructor(
    public readonly inner: AgentSessionLike,
    public readonly cwd: string = "",
    private readonly providerTracker?: ExtensionProviderTracker,
    initialDiagnostics: Array<{ type: string; message: string }> = [],
    private readonly refreshModelCatalog?: () => Promise<void>,
    private readonly webExtensionUI?: WebExtensionUIBridge,
    public readonly modelRegistry?: ModelRegistry,
  ) {
    this.extensionDiagnostics = initialDiagnostics.map((diagnostic) => ({
      type: diagnostic.type === "info" || diagnostic.type === "warning" ? diagnostic.type : "error",
      message: diagnostic.message,
      path: diagnostic.message.match(/Extension "([^"]+)"/)?.[1],
    }));
    this.webExtensionUI?.setEmitter((event) => {
      this.resetIdleTimer();
      const deliveredLive = this.listeners.length > 0;
      this.emitEvent(event);
      if (deliveredLive) this.webExtensionUI?.acknowledgeDelivery(event.id);
    });
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.resetIdleTimer();
      this.emitEvent(event);
      if (this.authRefreshPending) queueMicrotask(() => this.restartForAuthIfIdle());
    });
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.shutdown("quit"), 10 * 60 * 1000);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.webExtensionUI?.snapshot() ?? []) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  private emitEvent(event: AgentEvent | WebExtensionUIEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  recordExtensionError(error: ExtensionError): void {
    this.extensionDiagnostics.push({
      type: "error",
      message: `[${error.event}] ${error.error}`,
      path: error.extensionPath,
    });
  }

  getExtensionDiagnostics(): ExtensionDiagnosticInfo[] {
    return [...this.extensionDiagnostics];
  }

  getExtensionProviders(): ExtensionProviderInfo[] {
    return this.providerTracker?.snapshot() ?? [];
  }

  async refreshModels(): Promise<void> {
    await this.refreshModelCatalog?.();
  }

  private restartForAuthIfIdle(): boolean {
    if (!this._alive || !this.authRefreshPending) return false;
    if (this.inner.isStreaming || this.inner.isCompacting || this.bashRunning) return false;
    this.authRefreshPending = false;
    this.emitEvent({ type: "session_restart", reason: "auth" });
    this.destroy();
    return true;
  }

  requestAuthRefresh(): "restarted" | "deferred" {
    const alreadyPending = this.authRefreshPending;
    this.authRefreshPending = true;
    if (this.restartForAuthIfIdle()) return "restarted";
    if (!alreadyPending) {
      this.emitEvent({ type: "session_restart_deferred", reason: "auth" });
    }
    return "deferred";
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;

    switch (type) {
      case "prompt": {
        // Snapshot the working tree before the run so its file changes can be
        // rolled back later (best-effort; no-op outside a git repo). Awaited so
        // the capture lands before the agent starts editing.
        if (this.cwd) {
          await createSnapshot(this.cwd, this.inner.sessionId, "Before run").catch(() => {});
        }
        // Browser chat is fire-and-forget because events come via subscribe.
        // Background schedulers can opt into awaiting the underlying Promise
        // so an immediate setup/model rejection cannot leave a run stuck.
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const prompt = this.inner.prompt(command.message as string, promptImages?.length ? { images: promptImages } : undefined);
        if (command.awaitCompletion === true) await prompt;
        else prompt.catch(() => {});
        return null;
      }

      case "abort":
        await this.inner.abort();
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: 0,
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        await this.refreshModels();
        const registry = this.modelRegistry;
        if (!registry) throw new Error("Model registry is unavailable");
        const model = registry.find(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");
        if (!(await emitWebBeforeFork(this.inner.extensionRunner, entryId))) {
          return { cancelled: true };
        }

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        await this.shutdown("fork", newSessionFile);
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        return null;
      }

      case "compact": {
        // Pi owns compaction eligibility, including repeated compactions whose
        // boundary starts at the previous firstKeptEntryId. Duplicating that
        // private algorithm here caused valid repeated compactions to be rejected.
        return this.inner.compact(command.customInstructions as string | undefined);
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "set_tools": {
        const toolNames = withAskUserTool(command.toolNames as string[]);
        this.inner.setActiveToolsByName(toolNames);
        return null;
      }

      case "extension_ui_response":
        return this.webExtensionUI?.respond(command as unknown as WebExtensionUIResponse)
          ?? { accepted: false, reason: "not_found" };

      case "bash": {
        // Direct shell execution (the ! input prefix). Output chunks stream to
        // the client over the existing SSE channel as synthetic events; pi
        // records the result into the session so the agent sees it too.
        const bashCommand = command.command as string;
        const excludeFromContext = Boolean(command.excludeFromContext);
        const emit = (event: AgentEvent) => this.emitEvent(event);
        this.bashRunning = true;
        emit({ type: "bash_start", command: bashCommand });
        try {
          const result = await this.inner.executeBash(
            bashCommand,
            (chunk: string) => {
              this.resetIdleTimer();
              emit({ type: "bash_chunk", chunk });
            },
            { excludeFromContext },
          );
          emit({ type: "bash_end", exitCode: result.exitCode ?? null, cancelled: result.cancelled, truncated: result.truncated });
          return { output: result.output, exitCode: result.exitCode ?? null, cancelled: result.cancelled, truncated: result.truncated };
        } catch (e) {
          emit({ type: "bash_end", errorMessage: String(e) });
          throw e;
        } finally {
          this.bashRunning = false;
          this.restartForAuthIfIdle();
        }
      }

      case "abort_bash": {
        this.inner.abortBash();
        return null;
      }

      case "clear_queue": {
        const cleared = (this.inner as unknown as { clearQueue?: () => unknown }).clearQueue?.();
        return cleared ?? null;
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    this.webExtensionUI?.closeAll();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unsubscribe?.();
    this.inner.dispose();
    this.onDestroyCallback?.();
  }

  async shutdown(reason: SessionShutdownReason, targetSessionFile?: string): Promise<void> {
    if (!this._alive) return;
    try {
      await this.inner.extensionRunner?.emit({
        type: "session_shutdown",
        reason,
        ...(targetSessionFile ? { targetSessionFile } : {}),
      });
    } catch (error) {
      this.extensionDiagnostics.push({
        type: "error",
        message: `[session_shutdown] ${String(error)}`,
      });
    } finally {
      this.destroy();
    }
  }

  async reloadExtensions(): Promise<void> {
    if (this.inner.isStreaming || this.inner.isCompacting) {
      throw new Error("Session must be idle before reloading extensions");
    }
    this.providerTracker?.beginReload();
    try {
      await this.inner.reload();
      this.providerTracker?.finishReload();
    } catch (error) {
      this.providerTracker?.abortReload();
      throw error;
    }
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

/**
 * Credential mutations are persisted through a short-lived ModelRuntime.
 * Existing sessions intentionally restart so their private runtime reloads the
 * new credential snapshot instead of continuing with stale auth state.
 */
export function invalidateRpcSessionsForAuthChange(): { restarted: number; deferred: number } {
  let restarted = 0;
  let deferred = 0;
  for (const session of [...getRegistry().values()]) {
    if (session.requestAuthRefresh() === "restarted") restarted++;
    else deferred++;
  }
  return { restarted, deferred };
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * Pass toolNames to pre-configure active tools (empty array = all tools disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[]
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(cwd, undefined);

    // Determine which tools to pass based on requested toolNames.
    // Since v0.68.0, createAgentSession expects string[] tool names instead of Tool[] instances.
    // Pass all built-in coding tool names by default; for "all off", pass empty array.
    const allCodingToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];
    const selectedToolNames = toolNames === undefined ? undefined : withAskUserTool(toolNames);
    let toolsOption: string[] | undefined;
    if (selectedToolNames !== undefined) {
      toolsOption = selectedToolNames.length === 0 ? [] : [...allCodingToolNames, ASK_USER_TOOL_NAME];
    }

    const webExtensionUI = new WebExtensionUIBridge({ acceptDialogs: false });
    const { services, modelRegistry, providerTracker, refreshModelCatalog } = await createTrackedAgentServices(cwd);
    const { session: inner } = await createAgentSessionFromServices({
      services,
      sessionManager,
      customTools: [createAskUserTool(webExtensionUI)],
      ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
    });

    const piTheme = inner.extensionRunner?.getUIContext().theme;
    if (piTheme) webExtensionUI.setPiTheme(piTheme);
    webExtensionUI.setRecorder((record) => {
      inner.sessionManager.appendCustomEntry("web_ui_decision", record);
    });

    // If specific tool names were requested (non-empty), narrow active tools now
    if (selectedToolNames && selectedToolNames.length > 0) {
      inner.setActiveToolsByName(selectedToolNames);
    }

    // When all tools are disabled, clear the system prompt entirely.
    // pi's buildSystemPrompt always produces a non-empty prompt even with no tools;
    // the only way to truly clear it is to call agent.setSystemPrompt directly.
    if (toolNames?.length === 0) {
      inner.agent.state.systemPrompt = "";
    }

    const wrapper = new AgentSessionWrapper(
      inner,
      cwd,
      providerTracker,
      services.diagnostics,
      refreshModelCatalog,
      webExtensionUI,
      modelRegistry,
    );
    wrapper.start();
    try {
      await bindWebExtensions(inner, (error) => wrapper.recordExtensionError(error), webExtensionUI);
      // Avoid a startup deadlock if an extension asks from session_start
      // before the browser knows this session id. Dialogs are interactive from
      // this point onward, including commands, hooks, and model tool calls.
      webExtensionUI.enableDialogs();
    } catch (error) {
      wrapper.destroy();
      throw error;
    }

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}

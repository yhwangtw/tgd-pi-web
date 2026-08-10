import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  getAgentDir,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionError,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
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

interface RuntimeSessionMetadata {
  providerTracker: ExtensionProviderTracker;
  modelRegistry: ModelRegistry;
  refreshModelCatalog: () => Promise<void>;
  diagnostics: Array<{ type: string; message: string }>;
}

type RuntimeSessionMetadataResolver = (session: AgentSessionLike) => RuntimeSessionMetadata | undefined;
type SessionReplacementListener = (
  wrapper: AgentSessionWrapper,
  previousSessionId: string,
  nextSessionId: string,
) => void;

type SessionReplacementReason = "new" | "fork" | "switch" | "import";

interface RuntimeSessionTarget {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  sessionManager: SessionManager;
}

type RuntimeSessionIdentity = Omit<RuntimeSessionTarget, "sessionManager">;

type RuntimeRecoveryFactory = (target: RuntimeSessionTarget) => Promise<AgentSessionRuntime>;
type RuntimeTargetConflictCheck = (sessionPath: string) => void | Promise<void>;

export interface AgentRuntimeDiagnostics {
  state: "ready" | "replacing" | "failed" | "disposed";
  sessionId: string;
  sessionFile: string;
  cwd: string;
  connectedClients: number;
  replacementCount: number;
  pendingReplacement?: {
    reason: SessionReplacementReason;
    startedAt: string;
    previousSessionId: string;
  };
  lastReplacement?: {
    reason: SessionReplacementReason;
    at: string;
    previousSessionId: string;
    nextSessionId: string;
    cwd: string;
  };
  lastFailure?: {
    reason: SessionReplacementReason;
    at: string;
    message: string;
    recovered: boolean;
    recoveryError?: string;
  };
}

export class SessionRuntimeConflictError extends Error {
  constructor(readonly targetSessionId: string) {
    super(`Session ${targetSessionId} is already active in another runtime`);
    this.name = "SessionRuntimeConflictError";
  }
}

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
  private extensionDiagnostics: ExtensionDiagnosticInfo[];
  private currentInner: AgentSessionLike;
  private currentCwd: string;
  private currentProviderTracker?: ExtensionProviderTracker;
  private currentRefreshModelCatalog?: () => Promise<void>;
  private currentModelRegistry?: ModelRegistry;
  private sessionRuntime?: AgentSessionRuntime;
  private runtimeMetadata?: RuntimeSessionMetadataResolver;
  private onSessionReplaced?: SessionReplacementListener;
  private recoverRuntime?: RuntimeRecoveryFactory;
  private checkRuntimeTarget?: RuntimeTargetConflictCheck;
  private runtimeState: AgentRuntimeDiagnostics["state"] = "ready";
  private replacementCount = 0;
  private pendingReplacement?: AgentRuntimeDiagnostics["pendingReplacement"];
  private lastReplacement?: AgentRuntimeDiagnostics["lastReplacement"];
  private lastFailure?: AgentRuntimeDiagnostics["lastFailure"];
  private lastRecoveryTarget?: RuntimeSessionTarget;

  constructor(
    inner: AgentSessionLike,
    cwd: string = "",
    providerTracker?: ExtensionProviderTracker,
    initialDiagnostics: Array<{ type: string; message: string }> = [],
    refreshModelCatalog?: () => Promise<void>,
    private readonly webExtensionUI?: WebExtensionUIBridge,
    modelRegistry?: ModelRegistry,
    private readonly onActiveToolsChanged?: (toolNames: string[]) => void,
  ) {
    this.currentInner = inner;
    this.currentCwd = cwd;
    this.currentProviderTracker = providerTracker;
    this.currentRefreshModelCatalog = refreshModelCatalog;
    this.currentModelRegistry = modelRegistry;
    this.extensionDiagnostics = this.normalizeDiagnostics(initialDiagnostics);
    this.webExtensionUI?.setEmitter((event) => {
      this.resetIdleTimer();
      const deliveredLive = this.listeners.length > 0;
      this.emitEvent(event);
      if (deliveredLive) this.webExtensionUI?.acknowledgeDelivery(event.id);
    });
    this.configureWebExtensionUI();
  }

  private normalizeDiagnostics(
    diagnostics: Array<{ type: string; message: string }>,
  ): ExtensionDiagnosticInfo[] {
    return diagnostics.map((diagnostic) => ({
      type: diagnostic.type === "info" || diagnostic.type === "warning" ? diagnostic.type : "error",
      message: diagnostic.message,
      path: diagnostic.message.match(/Extension "([^"]+)"/)?.[1],
    }));
  }

  get inner(): AgentSessionLike {
    return this.currentInner;
  }

  get cwd(): string {
    return this.currentCwd;
  }

  get modelRegistry(): ModelRegistry | undefined {
    return this.currentModelRegistry;
  }

  attachRuntime(
    runtime: AgentSessionRuntime,
    metadata: RuntimeSessionMetadataResolver,
    onSessionReplaced: SessionReplacementListener,
    recoverRuntime?: RuntimeRecoveryFactory,
    checkRuntimeTarget?: RuntimeTargetConflictCheck,
  ): void {
    this.runtimeMetadata = metadata;
    this.onSessionReplaced = onSessionReplaced;
    this.recoverRuntime = recoverRuntime;
    this.checkRuntimeTarget = checkRuntimeTarget;
    this.installRuntime(runtime);
  }

  private installRuntime(runtime: AgentSessionRuntime): void {
    this.sessionRuntime = runtime;
    runtime.setBeforeSessionInvalidate(() => this.prepareForSessionReplacement());
    runtime.setRebindSession(async () => this.rebindRuntimeSession());
  }

  private configureWebExtensionUI(): void {
    if (!this.webExtensionUI) return;
    const runner = this.inner.extensionRunner as { getUIContext?: () => { theme?: unknown } } | undefined;
    const piTheme = runner?.getUIContext?.().theme;
    if (piTheme) this.webExtensionUI.setPiTheme(piTheme as never);
    this.webExtensionUI.setRecorder((record) => {
      this.inner.sessionManager.appendCustomEntry("web_ui_decision", record);
    });
  }

  private applyRuntimeMetadata(): void {
    const metadata = this.runtimeMetadata?.(this.inner);
    if (!metadata) return;
    this.currentProviderTracker = metadata.providerTracker;
    this.currentRefreshModelCatalog = metadata.refreshModelCatalog;
    this.currentModelRegistry = metadata.modelRegistry;
    this.extensionDiagnostics = this.normalizeDiagnostics(metadata.diagnostics);
  }

  private subscribeCurrentSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.resetIdleTimer();
      this.emitEvent(event);
      if (this.authRefreshPending) queueMicrotask(() => this.restartForAuthIfIdle());
    });
  }

  private prepareForSessionReplacement(): void {
    this.webExtensionUI?.resetForSessionReplacement();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async rebindRuntimeSession(): Promise<void> {
    const runtime = this.sessionRuntime;
    if (!runtime) return;
    const previousSessionId = this.currentInner.sessionId;
    this.currentInner = runtime.session as unknown as AgentSessionLike;
    this.currentCwd = runtime.cwd;
    this.applyRuntimeMetadata();
    this.configureWebExtensionUI();
    this.subscribeCurrentSession();
    await this.bindExtensions();

    const nextSessionId = this.currentInner.sessionId;
    const nextSessionFile = this.currentInner.sessionFile;
    if (nextSessionFile) cacheSessionPath(nextSessionId, nextSessionFile);
    this.onSessionReplaced?.(this, previousSessionId, nextSessionId);
  }

  async bindExtensions(): Promise<void> {
    if (!this.webExtensionUI) throw new Error("Web extension UI bridge is unavailable");
    await bindWebExtensions(
      this.inner,
      (error) => this.recordExtensionError(error),
      this.webExtensionUI,
      this.sessionRuntime ? {
        newSession: (options) => this.runRuntimeReplacement(
          "new",
          (runtime) => runtime.newSession(options),
        ),
        fork: async (entryId, options) => {
          const result = await this.runRuntimeReplacement(
            "fork",
            (runtime) => runtime.fork(entryId, options),
          );
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath, options) => {
          await this.ensureRuntimeTargetAvailable("switch", sessionPath);
          return this.runRuntimeReplacement(
            "switch",
            (runtime) => runtime.switchSession(sessionPath, options),
          );
        },
      } : undefined,
    );
    this.webExtensionUI?.enableDialogs();
  }

  private currentRuntimeTarget(): RuntimeSessionTarget {
    return {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      cwd: this.cwd,
      sessionManager: this.inner.sessionManager,
    };
  }

  private runtimeIdentity(target: RuntimeSessionTarget): RuntimeSessionIdentity {
    return {
      sessionId: target.sessionId,
      sessionFile: target.sessionFile,
      cwd: target.cwd,
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async ensureRuntimeTargetAvailable(
    reason: SessionReplacementReason,
    sessionPath: string,
  ): Promise<void> {
    try {
      await this.checkRuntimeTarget?.(sessionPath);
    } catch (error) {
      const active = this.currentRuntimeTarget();
      const failure: NonNullable<AgentRuntimeDiagnostics["lastFailure"]> = {
        reason,
        at: new Date().toISOString(),
        message: this.errorMessage(error),
        // The preflight runs before Pi invalidates the current runtime, so the
        // active session is preserved without a recovery rebuild.
        recovered: true,
      };
      this.lastFailure = failure;
      this.emitEvent({
        type: "session_replacement_failed",
        reason,
        message: failure.message,
        recovered: true,
        preflight: true,
        activeSessionId: active.sessionId,
        cwd: active.cwd,
        sessionFile: active.sessionFile,
      });
      throw error;
    }
  }

  private async restoreRuntime(target: RuntimeSessionTarget): Promise<RuntimeSessionTarget> {
    if (!this.recoverRuntime) throw new Error("Runtime recovery is unavailable");
    const failedRuntime = this.sessionRuntime;
    failedRuntime?.setRebindSession(undefined);
    failedRuntime?.setBeforeSessionInvalidate(undefined);

    const recoveredRuntime = await this.recoverRuntime(target);
    this.installRuntime(recoveredRuntime);
    await this.rebindRuntimeSession();
    this.runtimeState = "ready";
    return this.currentRuntimeTarget();
  }

  private async runRuntimeReplacement<T extends { cancelled: boolean }>(
    reason: SessionReplacementReason,
    operation: (runtime: AgentSessionRuntime) => Promise<T>,
  ): Promise<T> {
    const runtime = this.sessionRuntime;
    if (!runtime) throw new Error("Session runtime is unavailable");
    if (this.pendingReplacement) {
      throw new Error(`Session replacement already in progress: ${this.pendingReplacement.reason}`);
    }

    const previous = this.currentRuntimeTarget();
    const startedAt = new Date().toISOString();
    this.lastRecoveryTarget = previous;
    this.runtimeState = "replacing";
    this.pendingReplacement = { reason, startedAt, previousSessionId: previous.sessionId };
    try {
      const result = await operation(runtime);
      if (result.cancelled) {
        this.runtimeState = "ready";
        return result;
      }
      const next = this.currentRuntimeTarget();
      this.replacementCount++;
      this.lastReplacement = {
        reason,
        at: new Date().toISOString(),
        previousSessionId: previous.sessionId,
        nextSessionId: next.sessionId,
        cwd: next.cwd,
      };
      this.runtimeState = "ready";
      // Rebinding happens before an extension's withSession callback. Only
      // publish the replacement after the complete operation succeeds, or the
      // browser can navigate to a transient session that recovery immediately
      // rolls back.
      this.emitEvent({
        type: "session_replaced",
        previousSessionId: previous.sessionId,
        newSessionId: next.sessionId,
        cwd: next.cwd,
        sessionFile: next.sessionFile,
      });
      return result;
    } catch (error) {
      const failure: NonNullable<AgentRuntimeDiagnostics["lastFailure"]> = {
        reason,
        at: new Date().toISOString(),
        message: this.errorMessage(error),
        recovered: false,
      };
      this.lastFailure = failure;
      this.runtimeState = "failed";
      let active = previous;
      try {
        active = await this.restoreRuntime(previous);
        failure.recovered = true;
      } catch (recoveryError) {
        failure.recoveryError = this.errorMessage(recoveryError);
      }
      this.emitEvent({
        type: "session_replacement_failed",
        reason,
        message: failure.message,
        recovered: failure.recovered,
        recoveryError: failure.recoveryError,
        activeSessionId: active.sessionId,
        cwd: active.cwd,
        sessionFile: active.sessionFile,
      });
      throw error;
    } finally {
      this.pendingReplacement = undefined;
    }
  }

  async importSession(inputPath: string, cwdOverride?: string): Promise<{
    cancelled: boolean;
    newSessionId?: string;
    cwd?: string;
    sessionFile?: string;
  }> {
    await this.ensureRuntimeTargetAvailable("import", inputPath);
    const result = await this.runRuntimeReplacement(
      "import",
      (runtime) => runtime.importFromJsonl(inputPath, cwdOverride),
    );
    return result.cancelled
      ? { cancelled: true }
      : { cancelled: false, newSessionId: this.sessionId, cwd: this.cwd, sessionFile: this.sessionFile };
  }

  async recoverFailedRuntime(): Promise<RuntimeSessionIdentity> {
    if (this.runtimeState !== "failed" || !this.lastRecoveryTarget) {
      return this.runtimeIdentity(this.currentRuntimeTarget());
    }
    const active = await this.restoreRuntime(this.lastRecoveryTarget);
    if (this.lastFailure) this.lastFailure.recovered = true;
    const identity = this.runtimeIdentity(active);
    this.emitEvent({ type: "session_runtime_recovered", ...identity });
    return identity;
  }

  getRuntimeDiagnostics(): AgentRuntimeDiagnostics {
    return {
      state: this.runtimeState,
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      cwd: this.cwd,
      connectedClients: this.listeners.length,
      replacementCount: this.replacementCount,
      ...(this.pendingReplacement ? { pendingReplacement: { ...this.pendingReplacement } } : {}),
      ...(this.lastReplacement ? { lastReplacement: { ...this.lastReplacement } } : {}),
      ...(this.lastFailure ? { lastFailure: { ...this.lastFailure } } : {}),
    };
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
    this.subscribeCurrentSession();
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
    return this.currentProviderTracker?.snapshot() ?? [];
  }

  async refreshModels(): Promise<void> {
    await this.currentRefreshModelCatalog?.();
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
        if (this.sessionRuntime) {
          const result = await this.runRuntimeReplacement(
            "fork",
            (runtime) => runtime.fork(entryId, { position: "before" }),
          );
          if (result.cancelled) return { cancelled: true };
          return { cancelled: false, newSessionId: this.sessionId, selectedText: result.selectedText };
        }

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
        this.onActiveToolsChanged?.(toolNames);
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

      case "recover_runtime":
        return this.recoverFailedRuntime();

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    this.runtimeState = "disposed";
    this.webExtensionUI?.resetForSessionReplacement();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    const runtime = this.sessionRuntime;
    this.sessionRuntime = undefined;
    if (runtime) {
      runtime.setRebindSession(undefined);
      runtime.setBeforeSessionInvalidate(undefined);
      void runtime.dispose().catch(() => this.inner.dispose());
    } else {
      this.inner.dispose();
    }
    this.onDestroyCallback?.();
  }

  async shutdown(reason: SessionShutdownReason, targetSessionFile?: string): Promise<void> {
    if (!this._alive) return;
    if (reason === "quit" && this.sessionRuntime) {
      this.destroy();
      return;
    }
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
    this.currentProviderTracker?.beginReload();
    try {
      await this.inner.reload();
      this.currentProviderTracker?.finishReload();
    } catch (error) {
      this.currentProviderTracker?.abortReload();
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
    let selectedToolNames = toolNames === undefined ? undefined : withAskUserTool(toolNames);
    const webExtensionUI = new WebExtensionUIBridge({ acceptDialogs: false });
    const metadataBySession = new WeakMap<object, RuntimeSessionMetadata>();
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: runtimeCwd,
      sessionManager: runtimeSessionManager,
      sessionStartEvent,
    }) => {
      const tracked = await createTrackedAgentServices(runtimeCwd);
      let toolsOption: string[] | undefined;
      if (selectedToolNames !== undefined) {
        toolsOption = selectedToolNames.length === 0 ? [] : [...allCodingToolNames, ASK_USER_TOOL_NAME];
      }
      const result = await createAgentSessionFromServices({
        services: tracked.services,
        sessionManager: runtimeSessionManager,
        sessionStartEvent,
        customTools: [createAskUserTool(webExtensionUI)],
        ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
      });

      // If specific tool names were requested (non-empty), narrow active tools now.
      if (selectedToolNames && selectedToolNames.length > 0) {
        result.session.setActiveToolsByName(selectedToolNames);
      }

      // When all tools are disabled, clear the system prompt entirely.
      // pi's buildSystemPrompt always produces a non-empty prompt even with no tools;
      // the only way to truly clear it is to call agent.setSystemPrompt directly.
      if (selectedToolNames?.length === 0) {
        result.session.agent.state.systemPrompt = "";
      }

      metadataBySession.set(result.session, {
        providerTracker: tracked.providerTracker,
        modelRegistry: tracked.modelRegistry,
        refreshModelCatalog: tracked.refreshModelCatalog,
        diagnostics: tracked.services.diagnostics,
      });
      return {
        ...result,
        services: tracked.services,
        diagnostics: tracked.services.diagnostics,
      };
    };
    const sessionRuntime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager,
    });
    const inner = sessionRuntime.session;
    const initialMetadata = metadataBySession.get(inner);
    if (!initialMetadata) throw new Error("Pi runtime session metadata is unavailable");

    const wrapper = new AgentSessionWrapper(
      inner as unknown as AgentSessionLike,
      sessionRuntime.cwd,
      initialMetadata.providerTracker,
      initialMetadata.diagnostics,
      initialMetadata.refreshModelCatalog,
      webExtensionUI,
      initialMetadata.modelRegistry,
      (nextToolNames) => { selectedToolNames = [...nextToolNames]; },
    );
    const runtimeMetadata = (session: AgentSessionLike) => metadataBySession.get(session as unknown as object);
    const onSessionReplaced: SessionReplacementListener = (activeWrapper, previousSessionId, nextSessionId) => {
      const conflict = registry.get(nextSessionId);
      if (conflict?.isAlive() && conflict !== activeWrapper) {
        throw new SessionRuntimeConflictError(nextSessionId);
      }
      for (const [key, candidate] of registry) {
        if (candidate === activeWrapper && key !== nextSessionId) registry.delete(key);
      }
      registry.set(nextSessionId, activeWrapper);
      if (previousSessionId !== nextSessionId) {
        const nextSessionFile = activeWrapper.sessionFile;
        if (nextSessionFile) cacheSessionPath(nextSessionId, nextSessionFile);
      }
    };
    const recoverRuntime: RuntimeRecoveryFactory = async (target) => {
      // The old AgentSession is disposed during replacement, but its
      // SessionManager remains valid. Reusing it preserves unflushed headers,
      // ids, labels, names, and pending entries that do not exist on disk yet.
      return createAgentSessionRuntime(createRuntime, {
        cwd: target.cwd,
        agentDir: getAgentDir(),
        sessionManager: target.sessionManager,
        sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: target.sessionFile || undefined },
      });
    };
    const checkRuntimeTarget: RuntimeTargetConflictCheck = (targetSessionPath) => {
      const targetSessionId = SessionManager.open(targetSessionPath, undefined).getSessionId();
      const conflict = registry.get(targetSessionId);
      if (conflict?.isAlive() && conflict !== wrapper) {
        throw new SessionRuntimeConflictError(targetSessionId);
      }
    };
    wrapper.attachRuntime(
      sessionRuntime,
      runtimeMetadata,
      onSessionReplaced,
      recoverRuntime,
      checkRuntimeTarget,
    );
    wrapper.start();
    try {
      await wrapper.bindExtensions();
    } catch (error) {
      wrapper.destroy();
      throw error;
    }

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    wrapper.onDestroy(() => {
      for (const [key, candidate] of registry) {
        if (candidate === wrapper) registry.delete(key);
      }
    });
    registry.set(realSessionId, wrapper);

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}

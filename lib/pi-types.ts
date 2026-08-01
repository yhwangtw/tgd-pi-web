import type {
  AgentSessionEvent,
  ExtensionCommandContextActions,
  ExtensionError,
  ExtensionRunner,
  ExtensionUIContext,
  ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface ModelLike {
  id: string;
  provider: string;
}

export interface ToolInfo {
  name: string;
  description: string;
}

export interface NavigateTreeResult {
  editorText?: string;
  cancelled: boolean;
  aborted?: boolean;
}

export interface AgentSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly autoCompactionEnabled: boolean;
  readonly autoRetryEnabled: boolean;
  readonly model: ModelLike | undefined;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  readonly agent: { state?: { systemPrompt?: string; thinkingLevel?: string } };

  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: { images?: Array<{ type: "image"; data: string; mimeType: string }> }): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  setModel(model: ModelLike): Promise<void>;
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<NavigateTreeResult>;
  setThinkingLevel(level: string): void;
  compact(customInstructions?: string): Promise<unknown>;
  setAutoCompactionEnabled(enabled: boolean): void;
  setAutoRetryEnabled(enabled: boolean): void;
  steer(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  followUp(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  getAllTools(): ToolInfo[];
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
  abortCompaction(): void;
  executeBash(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean },
  ): Promise<{ output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean }>;
  abortBash(): void;
  getContextUsage(): ContextUsage | undefined;
  bindExtensions(bindings: {
    mode?: "rpc";
    uiContext?: ExtensionUIContext;
    commandContextActions?: ExtensionCommandContextActions;
    onError?: (error: ExtensionError) => void;
  }): Promise<void>;
  reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void>;
  dispose(): void;
  readonly extensionRunner: ExtensionRunner | undefined;
  /** Loader that discovered extensions and extension-contributed resources. */
  readonly resourceLoader?: ResourceLoader;
}

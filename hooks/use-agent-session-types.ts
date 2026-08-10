"use client";

import type { AgentMessage, SessionInfo, SessionTreeNode } from "@/lib/types";

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
  compactionSettings?: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
}

export interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

export type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

export function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * If an agent_end event's final assistant message carries stopReason "error",
 * return its error text — the run finished by failing, and every "done"
 * signal (sound, ✅ title, notification) should say so instead.
 */
export function getRunError(event: AgentEvent): string | null {
  if (event.type !== "agent_end") return null;
  const messages = event.messages as Array<{ role?: string; stopReason?: string; errorMessage?: string }> | undefined;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    if (m.stopReason === "error") return m.errorMessage || "Model call failed";
    return null; // last assistant message ended normally
  }
  return null;
}

export type AgentPhase =
  | { kind: "waiting_model"; tools?: undefined }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface SessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
}

export interface CompactResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter: number;
  details?: unknown;
}

export function isCompactionCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /compaction (?:cancelled|canceled)|aborted/i.test(message);
}

export function shouldApplySessionLoad(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}

/** Sum token usage and cost across all assistant messages; null when empty. */
export function computeSessionStats(messages: AgentMessage[]): SessionStats | null {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const u = (msg as import("@/lib/types").AssistantMessage).usage;
    if (!u) continue;
    tokens.input += u.input ?? 0;
    tokens.output += u.output ?? 0;
    tokens.cacheRead += u.cacheRead ?? 0;
    tokens.cacheWrite += u.cacheWrite ?? 0;
    cost += u.cost?.total ?? 0;
  }
  const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return total > 0 ? { tokens, cost } : null;
}

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string, cwd?: string, sessionFile?: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  setNewSessionModel?: (model: { provider: string; modelId: string } | null) => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
  onSessionNamed?: () => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  setText: (text: string) => void;
  addImages: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

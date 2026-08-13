"use client";

import { useState, useCallback, useRef, useEffect, useReducer } from "react";
import type { AgentMessage } from "@/lib/types";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import { showToast } from "@/hooks/useToast";
import { translate } from "@/lib/i18n";
import { setIdleTitle, setRunningTitle, setDoneTitle, setErrorTitle, setExtensionTitle, notifyDone, requestNotifyPermission } from "@/lib/attention";
import type { ToolEntry } from "@/components/modals/ToolPanel";
import type { SessionData, AgentEvent, AgentPhase, UseAgentSessionOptions, ThinkingLevelOption, ChatInputHandle, AttachedImage, CompactResult } from "./use-agent-session-types";
import { streamReducer, getRunError, computeSessionStats, isCompactionCancellation, shouldApplySessionLoad } from "./use-agent-session-types";
import { useAgentEvents, useRunProgress } from "./use-agent-connection";
import { useTranscriptScroll } from "./use-transcript-scroll";
import { shouldResyncOnVisible } from "@/lib/wake-resync";
import { useModelCatalog } from "./use-model-catalog";
import { extensionUIReducer, initialExtensionUIState } from "./use-extension-ui";
import {
  isWebExtensionUIEvent,
  type WebExtensionUIResponse,
  type WebExtensionUIResponseResult,
} from "@/lib/web-extension-ui-types";
import {
  moveQueuedFollowUp,
  updateQueuedFollowUp,
  type QueuedFollowUp,
} from "@/lib/queued-follow-ups";
import { createSessionReplacementChannel, type SessionReplacementChannel } from "@/lib/session-replacement-channel";
import {
  classifyProviderError,
  selectFallbackModel,
  type ProviderErrorKind,
  type ProviderRecoveryModel,
} from "@/lib/provider-recovery";

export type { SessionData, AgentPhase, ThinkingLevelOption, ChatInputHandle, AttachedImage };

interface LiveAgentState {
  isStreaming?: boolean;
  isCompacting?: boolean;
  autoCompactionEnabled?: boolean;
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
}

interface AgentStateEnvelope {
  running: boolean;
  state?: LiveAgentState;
}

const AUTO_PROVIDER_FALLBACK_KEY = "pi-auto-provider-fallback";

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSessionNamed,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [runtimeFailure, setRuntimeFailure] = useState<{ message: string; recoveryError?: string } | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [ephemeralNewSession, setEphemeralNewSession] = useState(false);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [autoProviderFallback, setAutoProviderFallback] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem(AUTO_PROVIDER_FALLBACK_KEY) === "1"; } catch { return false; }
  });
  const [providerRecovery, setProviderRecovery] = useState<{
    message: string;
    kind: ProviderErrorKind;
    retryAfterSeconds: number | null;
    candidate: ProviderRecoveryModel | null;
    automatic: boolean;
  } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [autoCompactionEnabled, setAutoCompactionEnabled] = useState<boolean | null>(null);
  const [autoCompactionUpdating, setAutoCompactionUpdating] = useState(false);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [agentStartedAt, setAgentStartedAt] = useState<number | null>(null);
  const [queuedFollowUps, setQueuedFollowUps] = useState<QueuedFollowUp[]>([]);
  const [queueUpdating, setQueueUpdating] = useState(false);
  const [bashRun, setBashRun] = useState<{ command: string; output: string; running: boolean } | null>(null);
  const [extensionUIState, dispatchExtensionUI] = useReducer(extensionUIReducer, initialExtensionUIState);
  // Streaming-update throttle (see the message_update case)
  const pendingStreamMsgRef = useRef<AgentMessage | null>(null);
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const agentRunningRef = useRef(false);
  const agentPhaseRef = useRef<AgentPhase>(null);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  // Already-named sessions never need auto-naming — skip the summarize call
  const hasSummarizedRef = useRef(Boolean(session?.name));
  const sessionNameRef = useRef<string | undefined>(session?.name);
  const sessionLoadRequestRef = useRef(0);
  const replacementChannelRef = useRef<SessionReplacementChannel | null>(null);
  const autoProviderFallbackRef = useRef(autoProviderFallback);
  const autoFallbackAttemptedRef = useRef(false);
  const autoFallbackInFlightRef = useRef(false);
  const autoFallbackRetryRef = useRef<((model: ProviderRecoveryModel) => void) | null>(null);

  const { eventSourceRef, lastEventAtRef, connectionState, connectEvents } = useAgentEvents(agentRunningRef, handleAgentEventRef);
  const { runProgress, resetRunProgress } = useRunProgress(
    agentRunning && extensionUIState.dialogs.length === 0,
    agentPhaseRef,
    lastEventAtRef,
    connectionState,
  );
  const {
    initialScrollDoneRef, lastUserMsgRef, pendingScrollToUserRef,
    messagesEndRef, scrollContainerRef,
  } = useTranscriptScroll(messages.length, agentRunning, agentRunningRef, session?.id ?? null);
  const {
    modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps,
    newSessionModel, setNewSessionModel,
  } = useModelCatalog(
    isNew,
    modelsRefreshKey,
    opts.setNewSessionModel,
    session?.id ?? null,
    session?.cwd ?? newSessionCwd,
  );

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? newSessionModel : currentModel;
  const currentModelRef = useRef(currentModel);
  const modelListRef = useRef(modelList);
  currentModelRef.current = currentModel;
  modelListRef.current = modelList;
  autoProviderFallbackRef.current = autoProviderFallback;

  const sessionStats = computeSessionStats(messages);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    const requestId = ++sessionLoadRequestRef.current;
    try {
      if (showLoading) setLoading(true);
      const url = includeState
        ? `/api/sessions/${encodeURIComponent(sid)}?includeState`
        : `/api/sessions/${encodeURIComponent(sid)}`;
      const res = await fetch(url);
      if (res.status === 404) {
        if (showLoading && shouldApplySessionLoad(requestId, sessionLoadRequestRef.current)) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData & { agentState?: AgentStateEnvelope };
      if (!shouldApplySessionLoad(requestId, sessionLoadRequestRef.current)) {
        return d.agentState ?? null;
      }
      setData(d);
      const info = (d as { info?: { name?: string } }).info;
      if (info?.name) sessionNameRef.current = info.name;
      setActiveLeafId(d.leafId);
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      if (d.compactionSettings) setAutoCompactionEnabled(d.compactionSettings.enabled);
      if (d.agentState?.state?.autoCompactionEnabled !== undefined) {
        setAutoCompactionEnabled(d.agentState.state.autoCompactionEnabled);
      }
      setCurrentModelOverride(null);
      setError(null);
      // If no live agent state, fall back to thinking level from session file
      if (!d.agentState?.state?.thinkingLevel && d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }
      return d.agentState ?? null;
    } catch (e) {
      if (shouldApplySessionLoad(requestId, sessionLoadRequestRef.current)) {
        setError(String(e));
      }
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    try {
      const url = leafId
        ? `/api/sessions/${encodeURIComponent(sid)}/context?leafId=${encodeURIComponent(leafId)}`
        : `/api/sessions/${encodeURIComponent(sid)}/context`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[] } };
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, []);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/components/modals/ToolPanel");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);
  agentPhaseRef.current = agentPhase;

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    if (event.type === "connected") {
      // The server immediately follows this with a complete Web UI snapshot.
      // Reset first so status/widgets removed while this tab was offline do
      // not survive the reconnect as stale client-only state.
      dispatchExtensionUI({ type: "reset" });
      return;
    }
    if (isWebExtensionUIEvent(event)) {
      dispatchExtensionUI({ type: "event", event });
      resetRunProgress();
      if (event.type === "extension_ui_request") {
        if (event.method === "notify") {
          showToast(event.message, {
            type: event.notifyType ?? "info",
            duration: event.notifyType === "error" ? 8000 : 5000,
          });
        } else if (event.method === "setTitle") {
          setExtensionTitle(event.title);
        } else if (event.method === "set_editor_text") {
          opts.chatInputRef?.current?.setText(event.text);
        }
      }
      return;
    }
    switch (event.type) {
      case "session_replaced": {
        const previousSessionId = typeof event.previousSessionId === "string" ? event.previousSessionId : sessionIdRef.current ?? "";
        const nextSessionId = typeof event.newSessionId === "string" ? event.newSessionId : "";
        if (!nextSessionId) break;
        sessionIdRef.current = nextSessionId;
        dispatchExtensionUI({ type: "reset" });
        replacementChannelRef.current?.publish({
          previousSessionId,
          newSessionId: nextSessionId,
          ...(typeof event.cwd === "string" ? { cwd: event.cwd } : {}),
          ...(typeof event.sessionFile === "string" ? { sessionFile: event.sessionFile } : {}),
        });
        onSessionForked?.(
          nextSessionId,
          typeof event.cwd === "string" ? event.cwd : undefined,
          typeof event.sessionFile === "string" ? event.sessionFile : undefined,
        );
        break;
      }
      case "session_replacement_failed": {
        const message = typeof event.message === "string" ? event.message : translate("toast.runtimeReplacementFailed");
        const activeSessionId = typeof event.activeSessionId === "string" ? event.activeSessionId : "";
        if (event.recovered === true) {
          setRuntimeFailure(null);
          const recoveryLabel = event.preflight === true
            ? translate("toast.runtimeReplacementRejected")
            : translate("toast.runtimeRecovered");
          showToast(`${recoveryLabel}: ${message}`, { type: "warning", duration: 8000 });
          if (activeSessionId && activeSessionId !== sessionIdRef.current) {
            sessionIdRef.current = activeSessionId;
            onSessionForked?.(
              activeSessionId,
              typeof event.cwd === "string" ? event.cwd : undefined,
              typeof event.sessionFile === "string" ? event.sessionFile : undefined,
            );
          }
        } else {
          setRuntimeFailure({
            message,
            ...(typeof event.recoveryError === "string" ? { recoveryError: event.recoveryError } : {}),
          });
          showToast(translate("toast.runtimeRecoveryRequired"), { type: "error", duration: 10_000 });
        }
        break;
      }
      case "session_runtime_recovered": {
        setRuntimeFailure(null);
        const activeSessionId = typeof event.sessionId === "string" ? event.sessionId : "";
        if (activeSessionId && activeSessionId !== sessionIdRef.current) {
          sessionIdRef.current = activeSessionId;
          onSessionForked?.(
            activeSessionId,
            typeof event.cwd === "string" ? event.cwd : undefined,
            typeof event.sessionFile === "string" ? event.sessionFile : undefined,
          );
        }
        showToast(translate("toast.runtimeReconnected"), { type: "success" });
        break;
      }
      case "session_restart_deferred":
        showToast(translate("toast.authRefreshDeferred"), { type: "info", duration: 6000 });
        break;
      case "session_restart": {
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        const sid = sessionIdRef.current;
        if (!sid) break;
        setTimeout(() => {
          void connectEvents(sid).then(async (connected) => {
            if (!connected) {
              showToast(translate("toast.authReconnectFailed"), { type: "warning", duration: 8000 });
              return;
            }
            await loadSession(sid, false, true);
            showToast(translate("toast.authReconnected"), { type: "success", duration: 5000 });
          });
        }, 50);
        break;
      }
      case "agent_start":
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        setAgentStartedAt(Date.now());
        lastEventAtRef.current = Date.now();
        resetRunProgress();
        setRunningTitle(sessionNameRef.current);
        dispatch({ type: "start" });
        // Reload so user messages injected mid-stream (steer, queued
        // follow-ups) show up in the transcript from the session file.
        if (sessionIdRef.current) loadSession(sessionIdRef.current);
        break;
      case "agent_end":
        // Cancel any throttled streaming frame (aborted runs may end without
        // a message_end).
        pendingStreamMsgRef.current = null;
        if (streamFlushTimerRef.current != null) {
          clearTimeout(streamFlushTimerRef.current);
          streamFlushTimerRef.current = null;
        }
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        setAgentStartedAt(null);
        // Queued follow-ups are consumed right after this event; the next
        // agent_start reload will surface them as real messages.
        setQueuedFollowUps([]);
        resetRunProgress();
        {
          const runError = getRunError(event);
          if (runError) {
            const classified = classifyProviderError(runError);
            const current = currentModelRef.current;
            let candidate = selectFallbackModel(
              current,
              modelListRef.current.map((model) => ({ provider: model.provider, modelId: model.id, name: model.name })),
            );
            if ((classified.kind === "billing" || classified.kind === "authentication")
              && candidate?.provider === current?.provider) candidate = null;
            setProviderRecovery({
              message: runError,
              kind: classified.kind,
              retryAfterSeconds: classified.retryAfterSeconds,
              candidate,
              automatic: autoProviderFallbackRef.current,
            });
            if (autoProviderFallbackRef.current
              && classified.recoverableWithFallback
              && candidate
              && !autoFallbackAttemptedRef.current) {
              autoFallbackAttemptedRef.current = true;
              window.setTimeout(() => autoFallbackRetryRef.current?.(candidate as ProviderRecoveryModel), 350);
            }
            showToast(`Model error: ${runError}`, { type: "error", duration: 8000 });
            setErrorTitle(sessionNameRef.current);
            notifyDone(sessionNameRef.current, runError);
          } else {
            setProviderRecovery(null);
            autoFallbackAttemptedRef.current = false;
            setDoneTitle(sessionNameRef.current);
            notifyDone(sessionNameRef.current);
          }
        }
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          // includeState piggybacks contextUsage/systemPrompt on the session
          // reload — one request instead of two.
          loadSession(sessionIdRef.current, false, true).then((agentState) => {
            if (agentState?.state) {
              if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
              if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
            }
          });
          // Auto-name session after first turn (background, fire-and-forget)
          if (!hasSummarizedRef.current) {
            hasSummarizedRef.current = true;
            fetch(`/api/agent/${encodeURIComponent(sessionIdRef.current)}/summarize`, { method: "POST" })
              .then(() => onSessionNamed?.())
              .catch(() => {});
          }
        }
        onAgentEnd?.();
        break;
      case "message_start":
      case "message_update": {
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          const normalized = normalizeToolCalls(msg as AgentMessage);
          if (event.type === "message_start") {
            dispatch({ type: "update", message: normalized });
          } else {
            // Throttle streaming updates: every chunk re-parses the whole
            // message's markdown (O(length) per token). Batch to ~12
            // frames/sec — the last chunk in each window wins.
            pendingStreamMsgRef.current = normalized;
            if (streamFlushTimerRef.current == null) {
              streamFlushTimerRef.current = setTimeout(() => {
                streamFlushTimerRef.current = null;
                if (pendingStreamMsgRef.current) {
                  dispatch({ type: "update", message: pendingStreamMsgRef.current });
                  pendingStreamMsgRef.current = null;
                }
              }, 80);
            }
          }
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        // Drop any pending throttled frame — the completed message wins, and
        // a late flush after the reset would resurrect the streaming bubble.
        pendingStreamMsgRef.current = null;
        if (streamFlushTimerRef.current != null) {
          clearTimeout(streamFlushTimerRef.current);
          streamFlushTimerRef.current = null;
        }
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role !== "user") {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "bash_start":
        setBashRun({ command: event.command as string, output: "", running: true });
        break;
      case "bash_chunk":
        setBashRun((prev) => prev ? { ...prev, output: prev.output + (event.chunk as string) } : prev);
        break;
      case "bash_end":
        setBashRun((prev) => prev ? { ...prev, running: false } : prev);
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          const message = event.errorMessage as string;
          setCompactError(message);
          if (event.reason !== "manual") {
            showToast(`${translate("toast.compactFailed")}: ${message}`, { type: "error", duration: 8000 });
          }
        } else if (!event.aborted) {
          if (sessionIdRef.current) {
            loadSession(sessionIdRef.current, false, true).then((agentState) => {
              if (agentState?.state?.contextUsage !== undefined) {
                setContextUsage(agentState.state.contextUsage ?? null);
              }
            });
          }
          if (event.reason !== "manual") {
            const result = event.result as Partial<CompactResult> | undefined;
            const message = result && Number.isFinite(result.tokensBefore) && Number.isFinite(result.estimatedTokensAfter)
              ? translate("toast.compactDoneWithTokens")
                  .replace("{before}", Number(result.tokensBefore).toLocaleString())
                  .replace("{after}", Number(result.estimatedTokensAfter).toLocaleString())
              : translate("toast.compactDone");
            showToast(message, { type: "success", duration: 6000 });
          }
        }
        break;
    }
  }, [connectEvents, eventSourceRef, loadSession, onAgentEnd, onSessionForked, onSessionNamed, lastEventAtRef, resetRunProgress, opts.chatInputRef]);
  handleAgentEventRef.current = handleAgentEvent;

  useEffect(() => {
    const channel = createSessionReplacementChannel((replacement) => {
      if (sessionIdRef.current !== replacement.previousSessionId) return;
      sessionIdRef.current = replacement.newSessionId;
      dispatchExtensionUI({ type: "reset" });
      onSessionForked?.(
        replacement.newSessionId,
        replacement.cwd,
        replacement.sessionFile,
      );
    });
    replacementChannelRef.current = channel;
    return () => {
      if (replacementChannelRef.current === channel) replacementChannelRef.current = null;
      channel.close();
    };
  }, [onSessionForked]);

  const handleExtensionUIResponse = useCallback(async (response: WebExtensionUIResponse) => {
    const sid = sessionIdRef.current;
    if (!sid) throw new Error(translate("extensionUI.noSession"));
    const result = await sendAgentCommand<WebExtensionUIResponseResult>(sid, response);
    if (!result?.accepted) {
      throw new Error(result?.reason === "not_found"
        ? translate("extensionUI.expired")
        : translate("extensionUI.invalidResponse"));
    }
    dispatchExtensionUI({
      type: "event",
      event: {
        type: "extension_ui_closed",
        id: response.id,
        reason: "cancelled" in response ? "cancelled" : "answered",
      },
    });
  }, []);

  // Shared by the tGD-command and plain-prompt paths of handleSend: create a
  // new agent session with the current model/tool/thinking selections, wire up
  // SSE, and notify the parent.
  const createNewSession = useCallback(async (
    message: string,
    piImages?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<string> => {
    if (!newSessionCwd) throw new Error("No cwd for new session");
    const selectedModel = newSessionModel;
    if (selectedModel) setPendingModel(selectedModel);
    const { PRESET_NONE, PRESET_DEFAULT, PRESET_FULL } = await import("@/components/modals/ToolPanel");
    const toolNames = toolPreset === "none" ? PRESET_NONE : toolPreset === "default" ? PRESET_DEFAULT : PRESET_FULL;
    const res = await fetch("/api/agent/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: newSessionCwd,
        type: "prompt",
        message,
        toolNames,
        ephemeral: ephemeralNewSession,
        ...(piImages?.length ? { images: piImages } : {}),
        ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
        ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json() as { sessionId: string };
    sessionIdRef.current = result.sessionId;
    connectEvents(result.sessionId);
    onSessionCreated?.({
      id: result.sessionId,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 1,
      firstMessage: message,
      ephemeral: ephemeralNewSession,
    });
    return result.sessionId;
  }, [newSessionCwd, newSessionModel, toolPreset, thinkingLevel, ephemeralNewSession, connectEvents, onSessionCreated]);

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    if (!message.trim() && !images?.length) return false;
    if (agentRunning) return false;
    const fallbackRetry = autoFallbackInFlightRef.current;
    autoFallbackInFlightRef.current = false;
    if (!fallbackRetry) {
      autoFallbackAttemptedRef.current = false;
      setProviderRecovery(null);
    }
    requestNotifyPermission();

    // Bash mode: `!cmd` runs the shell directly (streamed, recorded into the
    // session so the agent sees the result); `!!cmd` keeps it out of context.
    const trimmedForBash = message.trim();
    if (trimmedForBash.startsWith("!") && trimmedForBash.length > 1) {
      if (isNew || !session) {
        showToast("Bash mode needs an active session — send a message first", { type: "warning" });
        return false;
      }
      const excludeFromContext = trimmedForBash.startsWith("!!");
      const bashCommand = trimmedForBash.replace(/^!+/, "").trim();
      if (!bashCommand) return false;
      if (!(await connectEvents(session.id))) {
        console.warn("SSE stream not open before bash send — early output may be missed");
      }
      setBashRun({ command: bashCommand, output: "", running: true });
      try {
        await sendAgentCommand(session.id, { type: "bash", command: bashCommand, excludeFromContext });
        // Reload so the persisted bashExecution entry replaces the live block
        await loadSession(session.id);
        return true;
      } catch (e) {
        console.error("Bash failed:", e);
        showToast(`Bash failed: ${e instanceof Error ? e.message : e}`, { type: "error" });
        return false;
      } finally {
        setBashRun(null);
      }
    }
    // Slash commands (/tgd-* included) are NOT special-cased here: they go
    // through the normal prompt path below, where pi's own prompt() resolves
    // them (extension command → input hook → skill → prompt template → plain
    // text). Routing them through /api/agent/[id]/command instead used to
    // break resumed sessions whenever the exact name wasn't a registered
    // extension command, while fresh sessions — which always used the prompt
    // path — worked.

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    // A page can sit idle for hours before the next prompt. Reset the progress
    // clock at the user action, not only when agent_start eventually arrives,
    // or a slow connection can inherit the previous run's stale idle time.
    lastEventAtRef.current = Date.now();
    resetRunProgress();
    setMessages((prev) => [...prev, userMsg]);
    setAgentRunning(true);
    setAgentPhase({ kind: "waiting_model" });
    setAgentStartedAt(Date.now());
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

    try {
      if (isNew && newSessionCwd) {
        await createNewSession(message, piImages);
      } else if (session) {
        // Wait for the SSE stream to be open before prompting, so the run's
        // first events aren't emitted before we're subscribed.
        if (!(await connectEvents(session.id))) {
          console.warn("SSE stream not open before prompt — early events may be missed");
        }
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      } else {
        throw new Error("No active session");
      }
      return true;
    } catch (e) {
      console.error("Failed to send message:", e);
      showToast(`${translate("toast.messageNotSent")}: ${e instanceof Error ? e.message : e}`, { type: "error" });
      setMessages((prev) => {
        const index = prev.lastIndexOf(userMsg);
        return index < 0 ? prev : [...prev.slice(0, index), ...prev.slice(index + 1)];
      });
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
      return false;
    }
  }, [isNew, newSessionCwd, session, agentRunning, connectEvents, createNewSession, loadSession, lastEventAtRef, pendingScrollToUserRef, resetRunProgress]);

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  const handleRuntimeReconnect = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const active = await sendAgentCommand<{ sessionId: string; cwd: string; sessionFile: string }>(sid, {
        type: "recover_runtime",
      });
      if (!active) throw new Error("Runtime recovery returned no active session");
      setRuntimeFailure(null);
      if (active.sessionId !== sid) {
        sessionIdRef.current = active.sessionId;
        onSessionForked?.(active.sessionId, active.cwd, active.sessionFile);
      } else {
        await loadSession(active.sessionId, false, true);
      }
    } catch (reason) {
      showToast(`${translate("toast.runtimeRecoveryRequired")}: ${reason instanceof Error ? reason.message : reason}`, {
        type: "error",
        duration: 10_000,
      });
    }
  }, [loadSession, onSessionForked]);

  const handleFork = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId && sessionIdRef.current !== newSessionId) {
        sessionIdRef.current = newSessionId;
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
      showToast(`${translate("toast.forkFailed")}: ${e instanceof Error ? e.message : e}`, { type: "error" });
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string): Promise<boolean> => {
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      return true;
    }
    const sid = sessionIdRef.current;
    if (!sid) return false;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      // Any session fetch already in flight was started before this model
      // change and must not overwrite the optimistic selection when it lands.
      sessionLoadRequestRef.current += 1;
      setCurrentModelOverride({ provider, modelId });
      return true;
    } catch (e) {
      console.error("Failed to set model:", e);
      showToast(`${translate("recovery.switchFailed")}: ${e instanceof Error ? e.message : e}`, { type: "error" });
      return false;
    }
  }, [isNew, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    try {
      const result = await sendAgentCommand<CompactResult>(sid, { type: "compact" });
      const agentState = await loadSession(sid, true, true);
      if (agentState?.state?.contextUsage !== undefined) {
        setContextUsage(agentState.state.contextUsage ?? null);
      }
      const message = Number.isFinite(result?.tokensBefore) && Number.isFinite(result?.estimatedTokensAfter)
        ? translate("toast.compactDoneWithTokens")
            .replace("{before}", Number(result.tokensBefore).toLocaleString())
            .replace("{after}", Number(result.estimatedTokensAfter).toLocaleString())
        : translate("toast.compactDone");
      showToast(message, { type: "success", duration: 6000 });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isCompactionCancellation(e)) {
        setCompactError(null);
        showToast(translate("toast.compactCancelled"), { type: "info" });
        return;
      }
      setCompactError(message);
      showToast(`${translate("toast.compactFailed")}: ${message}`, { type: "error", duration: 8000 });
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const handleAutoCompactionChange = useCallback(async (enabled: boolean) => {
    const sid = sessionIdRef.current;
    if (!sid || autoCompactionUpdating) return;
    const previous = autoCompactionEnabled;
    setAutoCompactionUpdating(true);
    setAutoCompactionEnabled(enabled);
    try {
      await sendAgentCommand(sid, { type: "set_auto_compaction", enabled });
      showToast(translate(enabled ? "toast.autoCompactOn" : "toast.autoCompactOff"), { type: "success" });
    } catch (e) {
      setAutoCompactionEnabled(previous);
      const message = e instanceof Error ? e.message : String(e);
      showToast(`${translate("toast.autoCompactFailed")}: ${message}`, { type: "error", duration: 8000 });
    } finally {
      setAutoCompactionUpdating(false);
    }
  }, [autoCompactionEnabled, autoCompactionUpdating]);

  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    const optimisticMessage = { role: "user", content: `[steer] ${message}`, timestamp: Date.now() } as AgentMessage;
    setMessages((prev) => [...prev, optimisticMessage]);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      return true;
    } catch (e) {
      console.error("Failed to steer:", e);
      setMessages((prev) => {
        const index = prev.lastIndexOf(optimisticMessage);
        return index < 0 ? prev : [...prev.slice(0, index), ...prev.slice(index + 1)];
      });
      showToast(`${translate("toast.steerFailed")}: ${e instanceof Error ? e.message : e}`, { type: "error" });
      return false;
    }
  }, []);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    // Don't append to the transcript — the message hasn't been delivered yet.
    // It sits in a visible queue until the current run ends, then shows up as
    // a real user message via the agent_start reload.
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    const item: QueuedFollowUp = {
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      message,
      ...(piImages?.length ? { images: piImages } : {}),
    };
    setQueuedFollowUps((prev) => [...prev, item]);
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      return true;
    } catch (e) {
      console.error("Failed to follow up:", e);
      setQueuedFollowUps((prev) => prev.filter((queued) => queued.id !== item.id));
      showToast(`${translate("toast.followUpFailed")}: ${e instanceof Error ? e.message : e}`, { type: "error" });
      return false;
    }
  }, []);

  const handleClearQueue = useCallback(async (): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid || queueUpdating) return false;
    setQueueUpdating(true);
    try {
      await sendAgentCommand(sid, { type: "clear_queue" });
      setQueuedFollowUps([]);
      return true;
    } catch (e) {
      console.error("Failed to clear queue:", e);
      showToast(`${translate("toast.followUpFailed")}: ${e instanceof Error ? e.message : e}`, { type: "error" });
      return false;
    } finally {
      setQueueUpdating(false);
    }
  }, [queueUpdating]);

  const replaceQueuedFollowUps = useCallback(async (next: QueuedFollowUp[]): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid || queueUpdating) return false;
    setQueueUpdating(true);
    try {
      await sendAgentCommand(sid, { type: "clear_queue" });
      for (const item of next) {
        await sendAgentCommand(sid, {
          type: "follow_up",
          message: item.message,
          ...(item.images?.length ? { images: item.images.map((image) => ({ type: "image" as const, ...image })) } : {}),
        });
      }
      setQueuedFollowUps(next);
      return true;
    } catch (e) {
      showToast(`${translate("toast.followUpFailed")}: ${e instanceof Error ? e.message : e}`, { type: "error" });
      return false;
    } finally {
      setQueueUpdating(false);
    }
  }, [queueUpdating]);

  /**
   * Remove ONE queued follow-up. pi's queue API only clears wholesale, so
   * this clears and re-queues the survivors. If the run finishes mid-swap the
   * worst case is a follow-up delivering slightly later — never a duplicate.
   */
  const handleRemoveQueued = useCallback(async (id: string) => {
    return replaceQueuedFollowUps(queuedFollowUps.filter((item) => item.id !== id));
  }, [queuedFollowUps, replaceQueuedFollowUps]);

  const handleUpdateQueued = useCallback(async (id: string, message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return false;
    return replaceQueuedFollowUps(updateQueuedFollowUp(queuedFollowUps, id, trimmed));
  }, [queuedFollowUps, replaceQueuedFollowUps]);

  const handleMoveQueued = useCallback(async (id: string, direction: -1 | 1) => {
    const next = moveQueuedFollowUp(queuedFollowUps, id, direction);
    if (next === queuedFollowUps) return true;
    return replaceQueuedFollowUps(next);
  }, [queuedFollowUps, replaceQueuedFollowUps]);

  /**
   * Re-run the last failed exchange: roll back to the node before the last
   * user message (dropping the errored attempt into a dead branch), then
   * send the same prompt again.
   */
  const handleRetry = useCallback(async () => {
    if (agentRunning) return;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;
    const content = (messages[lastUserIdx] as { content?: unknown }).content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content as Array<{ type?: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
        : "";
    if (!text.trim()) return;
    let prevEntryId: string | undefined;
    for (let i = lastUserIdx - 1; i >= 0; i--) {
      if (entryIds[i]) { prevEntryId = entryIds[i]; break; }
    }
    if (prevEntryId) await handleNavigate(prevEntryId);
    await handleSend(text);
  }, [messages, entryIds, agentRunning, handleNavigate, handleSend]);

  const handleRetryWithModel = useCallback(async (model: ProviderRecoveryModel) => {
    if (agentRunning) return;
    const changed = await handleModelChange(model.provider, model.modelId);
    if (!changed) return;
    autoFallbackInFlightRef.current = true;
    setProviderRecovery(null);
    showToast(translate("recovery.switched").replace("{model}", model.name), { type: "success" });
    await handleRetry();
  }, [agentRunning, handleModelChange, handleRetry]);
  autoFallbackRetryRef.current = (model) => { void handleRetryWithModel(model); };

  const handleAutoProviderFallbackChange = useCallback((enabled: boolean) => {
    setAutoProviderFallback(enabled);
    autoProviderFallbackRef.current = enabled;
    try { localStorage.setItem(AUTO_PROVIDER_FALLBACK_KEY, enabled ? "1" : "0"); } catch { /* best effort */ }
    setProviderRecovery((current) => current ? { ...current, automatic: enabled } : current);
  }, []);

  // Edit an earlier user turn in place and re-run from there: roll the tree
  // back to the entry before it (prevEntryId — the assistant turn that
  // preceded it, same target the "Edit from here" nav uses) and send the new
  // text as a fresh branch. Same primitives as handleRetry, but for an
  // arbitrary message with edited content.
  const handleEditRerun = useCallback(async (prevEntryId: string | undefined, newText: string) => {
    if (agentRunning) return;
    if (!newText.trim()) return;
    if (prevEntryId) await handleNavigate(prevEntryId);
    await handleSend(newText);
  }, [agentRunning, handleNavigate, handleSend]);

  const handleAbortBash = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_bash" });
    } catch (e) {
      console.error("Failed to abort bash:", e);
    }
  }, []);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, []);

  const handleToolPresetChange = useCallback(async (preset: "none" | "default" | "full") => {
    const { PRESET_NONE, PRESET_DEFAULT, PRESET_FULL } = await import("@/components/modals/ToolPanel");
    const toolNames = preset === "none" ? PRESET_NONE : preset === "default" ? PRESET_DEFAULT : PRESET_FULL;
    setToolPresetState(preset);
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);

  // Load session on mount
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      setIdleTitle(session.name);
      if (session.ephemeral) {
        setLoading(false);
        void loadTools(session.id);
        return;
      }
      loadSession(session.id, true, true).then((agentState) => {
        if (agentState?.running) {
          loadTools(session.id);
          if (agentState.state?.isStreaming) {
            setAgentRunning(true);
            setAgentPhase({ kind: "waiting_model" });
            setAgentStartedAt(Date.now());
            lastEventAtRef.current = Date.now();
            resetRunProgress();
            connectEvents(session.id);
          }
        }
        if (agentState?.state) {
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          if (agentState.state.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(agentState.state.autoCompactionEnabled);
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
        }
      });
    }
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Wake / reconnect resync ──────────────────────────────────────────────
  // Mobile browsers freeze background tabs and drop the SSE stream. When the
  // tab comes back (or the network returns), reload the session to backfill
  // any messages missed while away, and reconnect the stream if a run is live.
  const hiddenSinceRef = useRef<number | null>(null);
  const resync = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    loadSession(sid, false, true).then((agentState) => {
      if (agentState?.state) {
        if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
        if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
        if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
        if (agentState.state.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(agentState.state.autoCompactionEnabled);
      }
      if (agentState?.running && agentState.state?.isStreaming) {
        setAgentRunning(true);
        if (!agentStartedAt) setAgentStartedAt(Date.now());
        lastEventAtRef.current = Date.now();
        resetRunProgress();
        void connectEvents(sid);
      } else if (agentRunningRef.current && !agentState?.running) {
        // The run finished while we were away — the "end" event was lost, so
        // reflect idle now instead of showing a stuck spinner.
        setAgentRunning(false);
        setAgentPhase(null);
        dispatch({ type: "end" });
      }
    });
  }, [agentStartedAt, connectEvents, lastEventAtRef, loadSession, resetRunProgress]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenSinceRef.current = Date.now();
        return;
      }
      if (shouldResyncOnVisible(hiddenSinceRef.current, Date.now())) resync();
      hiddenSinceRef.current = null;
    };
    const onOnline = () => resync();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [resync]);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  // Keep the inline error around long enough to read; the toast mirrors it.
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 8000);
    return () => clearTimeout(t);
  }, [compactError]);

  return {
    // State
    data, loading, error, runtimeFailure, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, providerRecovery, autoProviderFallback, ephemeralNewSession, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, autoCompactionEnabled, autoCompactionUpdating, currentModel, displayModel, sessionStats,
    agentPhase, agentStartedAt, queuedFollowUps, queueUpdating, bashRun, runProgress, extensionUIState,
    isNew,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleRuntimeReconnect, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleAutoCompactionChange, handleSteer, handleFollowUp, handleAbortCompaction,
    handleToolPresetChange, handleThinkingLevelChange, setEphemeralNewSession, handleClearQueue, handleRemoveQueued, handleUpdateQueued, handleMoveQueued, handleRetry, handleRetryWithModel, handleAutoProviderFallbackChange, setProviderRecovery, handleEditRerun, handleAbortBash, handleExtensionUIResponse, loadTools, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    // Subscriptions
    handleAgentEventRef,
  };
}

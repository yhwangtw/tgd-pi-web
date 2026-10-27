"use client";

import { keepActivePhase, phaseForMessage } from "./agent-phase";
import { useState, useCallback, useRef, useEffect, useLayoutEffect, useReducer, useMemo } from "react";
import type { AgentMessage } from "@/lib/types";
import { browserMetricsStorage, GenerationMetricsTracker } from "@/lib/generation-metrics";
import { getAssistantOutputIssue } from "@/lib/assistant-outcome";
import { RunLatencyTracker } from "@/lib/run-latency";
import { normalizeToolCalls } from "@/lib/normalize";
import { decodeSessionData, type SessionTreeWire } from "@/lib/session-tree-wire";
import { sendAgentCommand } from "@/lib/agent-client";
import { parseWorkflowCommand } from "@/lib/workflow-state";
import { showToast } from "@/hooks/useToast";
import { translate } from "@/lib/i18n";
import { presentProviderError } from "@/lib/provider-error-presentation";
import { setIdleTitle, setRunningTitle, setDoneTitle, setErrorTitle, setExtensionTitle, notifyDone, requestNotifyPermission } from "@/lib/attention";
import {
  DEFAULT_TOOL_CATALOG,
  namesForToolSelection,
  type ToolCatalogEntry,
  type ToolSelectionMode,
  type ToolSelectionState,
} from "@/lib/tool-selection";
import type { SessionData, AgentEvent, AgentPhase, UseAgentSessionOptions, ThinkingLevelOption, ChatInputHandle, AttachedImage } from "./use-agent-session-types";
import { streamReducer, getRunError, computeSessionStats, shouldApplySessionLoad } from "./use-agent-session-types";
import { retainedComposerDraft } from "@/lib/composer-submissions";
import type { ResolvedCompactionSettings } from "@/lib/compaction-policy";
import { transferComposerDraft } from "./useComposerDraft";
import { useSessionCompaction, type CompactionLiveState } from "./use-session-compaction";
import { useAgentEvents, useRunProgress } from "./use-agent-connection";
import { createStreamUpdateScheduler, hasStreamMessageContent, streamMessageSize } from "./stream-update-scheduler";
import { useTranscriptScroll } from "./use-transcript-scroll";
import { shouldResyncOnVisible } from "@/lib/wake-resync";
import { useModelCatalog } from "./use-model-catalog";
import { extensionUIReducer, extensionResponseFeedback, initialExtensionUIState } from "./use-extension-ui";
import {
  isWebExtensionUIEvent,
  type WebExtensionUIResponse,
  type WebExtensionUIResponseResult,
} from "@/lib/web-extension-ui-types";
import {
  moveQueuedFollowUp,
  normalizeQueuedFollowUps,
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

interface LiveAgentState extends CompactionLiveState {
  queuedFollowUps?: QueuedFollowUp[];
  isStreaming?: boolean;
  isCompacting?: boolean;
  autoCompactionEnabled?: boolean;
  compactionSettings?: ResolvedCompactionSettings;
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
    session, newSessionCwd, onAgentEnd, onAgentComplete, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSessionNamed,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [runtimeFailure, setRuntimeFailure] = useState<{ message: string; recoveryError?: string } | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [generationMetrics] = useState(() => new GenerationMetricsTracker(browserMetricsStorage()));
  const [runLatency] = useState(() => new RunLatencyTracker());
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  useLayoutEffect(() => { runLatency.committed(streamState.streamingMessage ?? messages.at(-1)); }, [messages, streamState.streamingMessage, runLatency]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [toolPreset, setToolPreset] = useState<ToolSelectionMode>("inherit");
  const [availableTools, setAvailableTools] = useState<ToolCatalogEntry[]>(DEFAULT_TOOL_CATALOG);
  const [customToolNames, setCustomToolNames] = useState<string[]>([]);
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
  const [autoCompactionEnabled, setAutoCompactionEnabled] = useState<boolean | null>(null);
  const [compactionSettings, setCompactionSettings] = useState<ResolvedCompactionSettings | null>(null);
  const [autoCompactionUpdating, setAutoCompactionUpdating] = useState(false);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [agentStartedAt, setAgentStartedAt] = useState<number | null>(null);
  const [queuedFollowUps, setQueuedFollowUps] = useState<QueuedFollowUp[]>([]);
  const [queueUpdating, setQueueUpdating] = useState(false);
  const [bashRun, setBashRun] = useState<{ command: string; output: string; running: boolean } | null>(null);
  const [extensionUIState, dispatchExtensionUI] = useReducer(extensionUIReducer, initialExtensionUIState);
  const authReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const streamMountedRef = useRef(true);
  const [streamScheduler] = useState(() => createStreamUpdateScheduler<{ sessionId: string | null; message: AgentMessage }>({
    publish: ({ message }) => dispatch({ type: "update", message: normalizeToolCalls(message) }),
    hasContent: ({ message }) => hasStreamMessageContent(message),
    size: ({ message }) => streamMessageSize(message),
    isCurrent: ({ sessionId }) => streamMountedRef.current && sessionId === sessionIdRef.current,
    isHidden: () => document.visibilityState === "hidden",
  }));
  useEffect(() => {
    streamMountedRef.current = true;
    return () => { streamMountedRef.current = false; streamScheduler.cancel(); };
  }, [streamScheduler]);
  // AppShell normally remounts per session. Also invalidate pending output when
  // a caller changes the selection without remounting this hook.
  // New-session creation also remounts the chat and bootstraps a new SSE stream.
  // End this observation: replay after remount cannot establish a cold TTFT.
  useEffect(() => () => { streamScheduler.cancel(); runLatency.finish("interrupted"); }, [session?.id, streamScheduler, runLatency]);
  const pendingPromptMessageRef = useRef<AgentMessage | null>(null);
  const pendingSendRef = useRef<AbortController | null>(null);
  const viewScope = useRef<object | null>(null);
  useLayoutEffect(() => {
    const scope = {};
    viewScope.current = scope;
    return () => { if (viewScope.current === scope) viewScope.current = null; };
  }, [session?.id, newSessionCwd]);
  const abortInFlightRef = useRef(false);
  const agentRunningRef = useRef(false);
  const agentPhaseRef = useRef<AgentPhase>(null);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  // Already-named sessions never need auto-naming — skip the summarize call
  const hasSummarizedRef = useRef(Boolean(session?.name));
  const sessionNameRef = useRef<string | undefined>(session?.name);
  useEffect(() => {
    sessionNameRef.current = session?.name;
    if (session?.name) hasSummarizedRef.current = true;
    if (agentRunningRef.current) setRunningTitle(session?.name);
    else setIdleTitle(session?.name);
  }, [session?.name]);
  const sessionLoadRequestRef = useRef(0);
  const replacementChannelRef = useRef<SessionReplacementChannel | null>(null);
  const autoProviderFallbackRef = useRef(autoProviderFallback);
  const autoFallbackAttemptedRef = useRef(false);
  const autoFallbackInFlightRef = useRef(false);
  const autoFallbackRetryRef = useRef<((model: ProviderRecoveryModel) => void) | null>(null);

  const { eventSourceRef, lastEventAtRef, connectionState, connectEvents } = useAgentEvents(agentRunningRef, handleAgentEventRef);
  const { runProgress, resetRunProgress } = useRunProgress(
    agentRunning && !isCompacting && extensionUIState.dialogs.length === 0,
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
    catalogStatus, catalogError, catalogDiagnostics, retryModelCatalog, reportModelUnavailable,
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

  const sessionStats = useMemo(() => computeSessionStats(messages), [messages]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    const requestId = ++sessionLoadRequestRef.current;
    try {
      if (showLoading) setLoading(true);
      const url = includeState
        ? `/api/sessions/${encodeURIComponent(sid)}?includeState`
        : `/api/sessions/${encodeURIComponent(sid)}`;
      const res = await fetch(url, { headers: { "X-Pi-Session-Tree": "flat-v2" } });
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
      const wire = await res.json() as Omit<SessionData, "tree"> & { tree: SessionData["tree"] | SessionTreeWire; agentState?: AgentStateEnvelope };
      if (!shouldApplySessionLoad(requestId, sessionLoadRequestRef.current)) {
        // Callers also reconcile running/thinking state from this return
        // value. Do not let an obsolete fetch resurrect a completed run.
        return null;
      }
      const d = decodeSessionData(wire);
      setData(d);
      const info = (d as { info?: { name?: string } }).info;
      if (info?.name) sessionNameRef.current = info.name;
      setActiveLeafId(d.leafId);
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      const resolvedCompaction = d.agentState?.state?.compactionSettings ?? d.compactionSettings ?? null;
      setCompactionSettings(resolvedCompaction);
      if (resolvedCompaction) setAutoCompactionEnabled(resolvedCompaction.enabled);
      if (d.agentState?.state?.autoCompactionEnabled !== undefined) {
        setAutoCompactionEnabled(d.agentState.state.autoCompactionEnabled);
      }
      setCurrentModelOverride(null);
      setError(null);
      // Model changes can clamp the previous thinking level. Reflect the
      // runtime's accepted value, including "off", instead of a stale choice.
      const acceptedThinking = d.agentState?.state?.thinkingLevel ?? d.context.thinkingLevel;
      if (acceptedThinking) setThinkingLevel(acceptedThinking as ThinkingLevelOption);
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

  const compaction = useSessionCompaction(sessionIdRef, setIsCompacting, () => {
    const sid = sessionIdRef.current;
    if (sid) void loadSession(sid, false, true).then(state => {
      if (state?.state?.contextUsage !== undefined) setContextUsage(state.state.contextUsage);
    });
  }, connectEvents);
  const handleCompact = compaction.start;
  const handleAbortCompaction = compaction.abort;
  const { handleEvent: handleCompactionEvent, reconcile: reconcileCompaction, enqueue: enqueueCompaction } = compaction;
  const compactError = compaction.view?.status === "failed" ? compaction.view.error ?? null : null;

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
      const result = await sendAgentCommand<ToolSelectionState | ToolCatalogEntry[]>(sid, { type: "get_tools" });
      if (sessionIdRef.current !== sid) return;
      if (Array.isArray(result)) {
        const { getPresetFromTools } = await import("@/components/modals/ToolPanel");
        const inferred = getPresetFromTools(result);
        setAvailableTools(result);
        setToolPresetState(inferred);
        if (inferred === "custom") setCustomToolNames(result.filter((tool) => tool.active).map((tool) => tool.name));
      } else if (result) {
        setAvailableTools(result.tools);
        setToolPresetState(result.mode);
        setCustomToolNames(result.mode === "custom" ? result.selectedNames : []);
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
    if (event.type !== "session_snapshot" || event.sessionId === sessionIdRef.current) {
      generationMetrics.record(sessionIdRef.current, event, performance.now());
      runLatency.record(event);
    }
    if (handleCompactionEvent(event)) return;
    if (event.type === "queue_update") { setQueuedFollowUps(previous => normalizeQueuedFollowUps(event, previous)); return; }
    if (event.type === "connected") {
      // The server immediately follows this with a complete Web UI snapshot.
      // Reset first so status/widgets removed while this tab was offline do
      // not survive the reconnect as stale client-only state.
      dispatchExtensionUI({ type: "reset" });
      return;
    }
    if (event.type === "session_snapshot") {
      if (event.sessionId !== sessionIdRef.current) return;
      // A checkpoint wins over fetches begun before replay, including loads
      // scheduled by replayed agent_start/end events.
      sessionLoadRequestRef.current += 1;
      streamScheduler.cancel();
      const state = event.state as LiveAgentState | undefined;
      const wire = event.sessionData as (Omit<SessionData, "tree"> & { tree: SessionData["tree"] | SessionTreeWire }) | undefined;
      if (wire?.context && Array.isArray(wire.context.messages)) {
        const restored = decodeSessionData(wire);
        setData(restored);
        setActiveLeafId(restored.leafId);
        setMessages(pendingPromptMessageRef.current ? [...restored.context.messages, pendingPromptMessageRef.current] : restored.context.messages);
        setEntryIds(restored.context.entryIds ?? []);
        setLoading(false);
        setError(null);
      }
      const pendingPrompt = pendingPromptMessageRef.current !== null;
      const wasRunning = agentRunningRef.current;
      const running = state?.isStreaming === true || pendingPrompt;
      agentRunningRef.current = running;
      setAgentRunning(running);
      setAgentPhase(running ? keepActivePhase((event.phase as AgentPhase) ?? null, phaseForMessage(event.streamingMessage as AgentMessage | undefined)) : null);
      setAgentStartedAt((current) => running ? current ?? Date.now() : null);
      if (state?.isCompacting !== undefined) setIsCompacting(state.isCompacting);
      reconcileCompaction(state);
      if (state?.compactionSettings) {
        setCompactionSettings(state.compactionSettings);
        setAutoCompactionEnabled(state.compactionSettings.enabled);
      }
      if (state?.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(state.autoCompactionEnabled);
      if (state?.contextUsage !== undefined) setContextUsage(state.contextUsage);
      if (state?.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt);
      if (state?.thinkingLevel !== undefined) setThinkingLevel(state.thinkingLevel as ThinkingLevelOption);
      if (state?.queuedFollowUps) setQueuedFollowUps(previous => normalizeQueuedFollowUps({ items: state.queuedFollowUps }, previous));
      const model = (event.state as { model?: { provider: string; id: string } } | undefined)?.model;
      if (model) setCurrentModelOverride({ provider: model.provider, modelId: model.id });
      setBashRun((event.bashRun as { command: string; output: string; running: boolean } | null) ?? null);
      if (running && event.streamingMessage) streamScheduler.start({ sessionId: sessionIdRef.current, message: event.streamingMessage as AgentMessage });
      else dispatch({ type: running ? "start" : "end" });
      if (!running) {
        setRetryInfo(null);
        setQueuedFollowUps([]);
        resetRunProgress();
        const outputIssue = getAssistantOutputIssue(wire?.context?.messages.findLast(message => message.role === "assistant"));
        if (outputIssue) {
          setProviderRecovery(null);
          setErrorTitle(sessionNameRef.current);
        } else if (typeof event.lastRunError === "string" && event.lastRunError) {
          const classified = classifyProviderError(event.lastRunError);
          setProviderRecovery({ message: event.lastRunError, kind: classified.kind, retryAfterSeconds: classified.retryAfterSeconds, candidate: null, automatic: false });
          setErrorTitle(sessionNameRef.current);
        } else {
          setProviderRecovery(null);
          if (wasRunning) setDoneTitle(sessionNameRef.current);
        }
      }
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
      case "session_closed":
        agentRunningRef.current = false;
        streamScheduler.cancel();
        // The terminal event is authoritative even if an individual question
        // close frame was lost before disconnect.
        dispatchExtensionUI({ type: "reset" });
        setAgentRunning(false);
        setAgentStartedAt(null);
        setAgentPhase(null);
        setBashRun(null);
        setRetryInfo(null);
        setQueuedFollowUps([]);
        dispatch({ type: "end" });
        break;
      case "session_replaced": {
        const previousSessionId = typeof event.previousSessionId === "string" ? event.previousSessionId : sessionIdRef.current ?? "";
        const nextSessionId = typeof event.newSessionId === "string" ? event.newSessionId : "";
        if (!nextSessionId) break;
        streamScheduler.cancel();
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
            streamScheduler.cancel();
            sessionIdRef.current = activeSessionId;
            onSessionForked?.(
              activeSessionId,
              typeof event.cwd === "string" ? event.cwd : undefined,
              typeof event.sessionFile === "string" ? event.sessionFile : undefined,
            );
          }
        } else {
          streamScheduler.cancel();
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
          streamScheduler.cancel();
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
        streamScheduler.cancel();
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        const sid = sessionIdRef.current;
        if (!sid) break;
        if (authReconnectTimerRef.current !== null) clearTimeout(authReconnectTimerRef.current);
        authReconnectTimerRef.current = setTimeout(() => {
          authReconnectTimerRef.current = null;
          if (sessionIdRef.current !== sid) return;
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
        streamScheduler.cancel();
        agentRunningRef.current = true;
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
      case "agent_end": {
        const observedRunning = agentRunningRef.current;
        agentRunningRef.current = false;
        streamScheduler.cancel();
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        setAgentStartedAt(null);
        // Queued follow-ups are consumed right after this event; the next
        // agent_start reload will surface them as real messages.
        setQueuedFollowUps([]);
        resetRunProgress();
        {
          const finalMessage = (event.messages as AgentMessage[] | undefined)?.findLast(message => message.role === "assistant");
          const outputIssue = getAssistantOutputIssue(finalMessage);
          const runError = getRunError(event);
          if (outputIssue) {
            setProviderRecovery(null);
            setErrorTitle(sessionNameRef.current);
            if (observedRunning && !event.replayed) notifyDone(sessionNameRef.current, translate(outputIssue === "output_limit" ? "chat.outputLimitTitle" : "chat.emptyOutputTitle"));
          } else if (runError) {
            const classified = classifyProviderError(runError);
            const failedMessage = (event.messages as AgentMessage[] | undefined)?.findLast((message) => message.role === "assistant");
            const current = failedMessage?.role === "assistant" && failedMessage.provider && failedMessage.model
              ? { provider: failedMessage.provider, modelId: failedMessage.model }
              : currentModelRef.current;
            if (classified.kind === "model_unavailable" && current) reportModelUnavailable(current);
            let candidate = selectFallbackModel(
              current,
              modelListRef.current.filter((model) => model.available !== false).map((model) => ({ provider: model.provider, modelId: model.id, name: model.name })),
            );
            if (!classified.recoverableWithFallback && classified.kind !== "model_unavailable") candidate = null;
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
            const { summary } = presentProviderError(runError, translate("chat.modelFailed"), {
              unsupported_setting: translate("recovery.unsupportedThinking"),
              model_unavailable: translate("recovery.modelRejected"),
            });
            setErrorTitle(sessionNameRef.current);
            // The transcript owns the error; do not add a duplicate toast.
            notifyDone(sessionNameRef.current, summary);
          } else {
            setProviderRecovery(null);
            autoFallbackAttemptedRef.current = false;
            if (event.goalActive) setRunningTitle(sessionNameRef.current);
            else {
              setDoneTitle(sessionNameRef.current);
              notifyDone(sessionNameRef.current);
            }
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
        const finalAssistant = Array.isArray(event.messages) ? (event.messages as AgentMessage[]).findLast((message) => message.role === "assistant") : undefined;
        if (observedRunning && !event.replayed && !getRunError(event) && finalAssistant?.stopReason !== "aborted") onAgentComplete?.();
        onAgentEnd?.();
        break;
      }
      case "message_start":
      case "message_update": {
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          const update = { sessionId: sessionIdRef.current, message: msg as AgentMessage };
          if (event.type === "message_start") streamScheduler.start(update);
          else streamScheduler.push(update);
        }
        setAgentPhase((previous) => keepActivePhase(previous, phaseForMessage(msg)));
        break;
      }
      case "message_end": {
        sessionLoadRequestRef.current += 1;
        // Drop any pending throttled frame — the completed message wins, and
        // a late flush after the reset would resurrect the streaming bubble.
        streamScheduler.cancel();
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role !== "user") {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        dispatch({ type: "reset" });
        setAgentPhase((previous) => keepActivePhase(previous, { kind: "waiting_model" }));
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        const label = typeof event.toolLabel === "string"
          ? event.toolLabel
          : typeof (event.tool as { label?: unknown } | undefined)?.label === "string"
            ? (event.tool as { label: string }).label
            : undefined;
        setAgentPhase((prev) => {
          if (prev?.kind === "stopping") return prev;
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name, ...(label ? { label } : {}) });
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
        streamScheduler.flush();
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
    }
  }, [connectEvents, eventSourceRef, loadSession, onAgentEnd, onAgentComplete, onSessionForked, onSessionNamed, lastEventAtRef, resetRunProgress, opts.chatInputRef, reportModelUnavailable, handleCompactionEvent, reconcileCompaction, generationMetrics, streamScheduler, runLatency]);
  handleAgentEventRef.current = handleAgentEvent;

  useEffect(() => {
    const channel = createSessionReplacementChannel((replacement) => {
      if (sessionIdRef.current !== replacement.previousSessionId) return;
      streamScheduler.cancel();
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
  }, [onSessionForked, streamScheduler]);

  const handleExtensionUIResponse = useCallback(async (response: WebExtensionUIResponse) => {
    const sid = sessionIdRef.current;
    if (!sid) throw new Error(translate("extensionUI.noSession"));
    const result = await sendAgentCommand<WebExtensionUIResponseResult>(sid, response);
    const feedback = extensionResponseFeedback(response, result);
    if (feedback.closed) dispatchExtensionUI({ type: "event", event: feedback.closed });
    if (feedback.errorKey) {
      // Another tab may already have completed/cancelled this question. Close
      // the stale card and explain the terminal result outside that card.
      if (feedback.closed) showToast(translate(feedback.errorKey), { type: "warning" });
      else throw new Error(translate(feedback.errorKey));
    }
  }, []);

  // Shared by the tGD-command and plain-prompt paths of handleSend: create a
  // new agent session with the current model/tool/thinking selections, wire up
  // SSE, and notify the parent.
  const createNewSession = useCallback(async (
    message: string,
    piImages?: Array<{ type: "image"; data: string; mimeType: string }>,
    signal?: AbortSignal,
    timingId?: string,
  ): Promise<string> => {
    const creatingScope = viewScope.current;
    if (!newSessionCwd) throw new Error("No cwd for new session");
    const selectedModel = newSessionModel;
    if (catalogStatus !== "ready" || !selectedModel) throw new Error(translate("model.catalogRequired"));
    if (selectedModel) setPendingModel(selectedModel);
    const toolNames = namesForToolSelection(toolPreset, customToolNames);
    const res = await fetch("/api/agent/new", {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: newSessionCwd,
        deferPrompt: true,
        type: "prompt",
        message,
        toolMode: toolPreset,
        ...(toolNames === undefined ? {} : { toolNames }),
        ephemeral: ephemeralNewSession,
        ...(piImages?.length ? { images: piImages } : {}),
        ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
        ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json() as { sessionId: string };
    signal?.throwIfAborted();
    sessionIdRef.current = result.sessionId;
    if (!(await connectEvents(result.sessionId, false, signal))) throw new Error(translate("connection.streamNotReady"));
    signal?.throwIfAborted();
    pendingPromptMessageRef.current = null;
    if (timingId) runLatency.requestSent(timingId);
    await sendAgentCommand(result.sessionId, { type: "prompt", message, ...(timingId ? { timingId } : {}), ...(piImages?.length ? { images: piImages } : {}) });
    if (signal?.aborted) {
      await sendAgentCommand(result.sessionId, { type: "abort" });
      runLatency.finish("aborted");
      signal.throwIfAborted();
    }
    // A late acknowledgement must not navigate a view that moved elsewhere.
    if (creatingScope && viewScope.current === creatingScope) {
      transferComposerDraft(`new:${newSessionCwd}`, result.sessionId, retainedComposerDraft(`new:${newSessionCwd}`));
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
    }
    return result.sessionId;
  }, [newSessionCwd, newSessionModel, catalogStatus, toolPreset, customToolNames, thinkingLevel, ephemeralNewSession, connectEvents, onSessionCreated, runLatency]);

  const handleWorkflowCommand = useCallback(async (message: string): Promise<boolean> => {
    const command = parseWorkflowCommand(message);
    const sid = sessionIdRef.current;
    if (!command || !sid) return false;
    try {
      if (!(await connectEvents(sid))) throw new Error(translate("connection.streamNotReady"));
      await sendAgentCommand(sid, { type: "workflow_command", ...command });
      if (sessionIdRef.current === sid) await loadTools(sid);
      return true;
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : String(reason), { type: "error" });
      return false;
    }
  }, [connectEvents, loadTools]);

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    if (!message.trim() && !images?.length) return false;
    if (!images?.length && sessionIdRef.current && parseWorkflowCommand(message)) return handleWorkflowCommand(message);
    const compactCommand = /^\/compact(?:\s+([\s\S]*))?$/.exec(message.trim());
    if (compactCommand && sessionIdRef.current && !images?.length) {
      await handleCompact(compactCommand[1]);
      return true;
    }
    if (isCompacting) return enqueueCompaction(message, images);
    if (agentRunning || pendingSendRef.current) return false;
    if (isNew && (catalogStatus !== "ready" || !newSessionModel)) {
      showToast(translate("model.catalogRequired"), { type: "warning" });
      return false;
    }
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
        showToast(translate("connection.streamNotReady"), { type: "error" });
        return false;
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
    const start = new AbortController();
    const timingId = runLatency.begin();
    pendingSendRef.current = start;
    pendingPromptMessageRef.current = userMsg;
    agentRunningRef.current = true;
    setMessages((prev) => [...prev, userMsg]);
    setAgentRunning(true);
    setAgentPhase({ kind: "waiting_model" });
    setAgentStartedAt(Date.now());
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

    try {
      if (isNew && newSessionCwd) {
        await createNewSession(message, piImages, start.signal, timingId);
      } else if (session) {
        // Wait for the SSE stream to be open before prompting, so the run's
        // first events aren't emitted before we're subscribed.
        if (!(await connectEvents(session.id, false, start.signal))) {
          start.signal.throwIfAborted();
          throw new Error(translate("connection.streamNotReady"));
        }
        start.signal.throwIfAborted();
        pendingPromptMessageRef.current = null;
        runLatency.requestSent(timingId);
        await sendAgentCommand(session.id, {
          type: "prompt",
          timingId,
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
        if (start.signal.aborted) {
          await sendAgentCommand(session.id, { type: "abort" });
          runLatency.finish("aborted");
          start.signal.throwIfAborted();
        }
      } else {
        throw new Error("No active session");
      }
      return true;
    } catch (e) {
      if (start.signal.aborted) runLatency.cancelPendingSend();
      else runLatency.finish("failed");
      pendingPromptMessageRef.current = null;
      if (!start.signal.aborted) console.error("Failed to send message:", e);
      if (!start.signal.aborted) showToast(`${translate("toast.messageNotSent")}: ${e instanceof Error ? e.message : e}`, { type: "error" });
      setMessages((prev) => {
        const index = prev.lastIndexOf(userMsg);
        return index < 0 ? prev : [...prev.slice(0, index), ...prev.slice(index + 1)];
      });
      agentRunningRef.current = false;
      streamScheduler.cancel();
      setAgentRunning(false);
      setAgentStartedAt(null);
      setAgentPhase(null);
      dispatch({ type: "end" });
      return false;
    } finally {
      if (pendingSendRef.current === start) pendingSendRef.current = null;
    }
  }, [isNew, newSessionCwd, newSessionModel, catalogStatus, session, agentRunning, connectEvents, createNewSession, loadSession, lastEventAtRef, pendingScrollToUserRef, resetRunProgress, isCompacting, enqueueCompaction, handleCompact, handleWorkflowCommand, streamScheduler, runLatency]);

  const handleAbort = useCallback(async () => {
    if (abortInFlightRef.current) return;
    abortInFlightRef.current = true;
    streamScheduler.flush();
    setAgentPhase({ kind: "stopping" });
    pendingSendRef.current?.abort();
    const sid = sessionIdRef.current;
    if (!sid) { abortInFlightRef.current = false; return; }
    try {
      await sendAgentCommand(sid, { type: "abort" });
      runLatency.finish("aborted");
    } catch (e) {
      console.error("Failed to abort:", e);
      showToast(translate("toast.stopFailed"), { type: "error" });
      setAgentPhase({ kind: "waiting_model" });
    } finally { abortInFlightRef.current = false; }
  }, [streamScheduler, runLatency]);

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
    if (modelListRef.current.some((model) => model.provider === provider && model.id === modelId && model.available === false)) return false;
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
      await loadSession(sid, false, true);
      setProviderRecovery(null);
      return true;
    } catch (e) {
      console.error("Failed to set model:", e);
      showToast(`${translate("recovery.switchFailed")}: ${e instanceof Error ? e.message : e}`, { type: "error" });
      return false;
    }
  }, [isNew, setNewSessionModel, loadSession]);

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
    if (!images?.length && parseWorkflowCommand(message)) return handleWorkflowCommand(message);
    if (isCompacting) return enqueueCompaction(message, images, "steer");
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
  }, [isCompacting, enqueueCompaction, handleWorkflowCommand]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    if (!images?.length && parseWorkflowCommand(message)) return handleWorkflowCommand(message);
    if (isCompacting) return enqueueCompaction(message, images);
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
        queueId: item.id,
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
  }, [isCompacting, enqueueCompaction, handleWorkflowCommand]);

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
      const saved = await sendAgentCommand<QueuedFollowUp[]>(sid, { type: "replace_queue", items: next });
      setQueuedFollowUps(previous => normalizeQueuedFollowUps({ items: saved }, previous));
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
    const images: AttachedImage[] = Array.isArray(content) ? content.flatMap(block => {
      if (block.type !== "image") return [];
      const data = block.source?.data ?? block.data;
      const mimeType = block.source?.media_type ?? block.mimeType;
      return typeof data === "string" && typeof mimeType === "string"
        ? [{ data, mimeType, previewUrl: `data:${mimeType};base64,${data}` }] : [];
    }) : [];
    if (!text.trim() && !images.length) return;
    let prevEntryId: string | undefined;
    for (let i = lastUserIdx - 1; i >= 0; i--) {
      if (entryIds[i]) { prevEntryId = entryIds[i]; break; }
    }
    if (prevEntryId) await handleNavigate(prevEntryId);
    await handleSend(text, images.length ? images : undefined);
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

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
      await loadSession(sid, false, true);
      setProviderRecovery((current) => current?.kind === "unsupported_setting" ? null : current);
    } catch (e) {
      console.error("Failed to set thinking level:", e);
      await loadSession(sid, false, true);
      showToast(translate("recovery.thinkingFailed"), { type: "error" });
    }
  }, [loadSession]);

  const handleToolPresetChange = useCallback(async (preset: ToolSelectionMode, selectedNames: string[] = []) => {
    const toolNames = namesForToolSelection(preset, selectedNames);
    const sid = sessionIdRef.current;
    if (!sid) {
      setToolPresetState(preset);
      setCustomToolNames(preset === "custom" ? selectedNames : []);
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "set_tools", mode: preset, toolNames: toolNames ?? [] });
      if (sessionIdRef.current === sid) await loadTools(sid);
    } catch (e) {
      console.error("Failed to set tools:", e);
      if (sessionIdRef.current === sid) showToast(translate("workflow.toolsFailed"), { type: "error" });
    }
  }, [loadTools, setToolPresetState]);

  // Load session on mount
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      setIdleTitle(session.name);
      if (session.ephemeral) {
        setLoading(false);
        void loadTools(session.id);
        // In-memory sessions have no JSONL to reload; the runtime snapshot is
        // their authoritative transcript, including an already-finished run.
        void connectEvents(session.id);
      } else loadSession(session.id, true, true).then((agentState) => {
        if (agentState?.running) {
          loadTools(session.id);
          if (agentState.state?.isStreaming) {
            setAgentRunning(true);
            setAgentPhase({ kind: "waiting_model" });
            setAgentStartedAt(Date.now());
            lastEventAtRef.current = Date.now();
            resetRunProgress();
          }
          // An alive idle wrapper may have completed before this view mounted
          // or still own pending extension UI. Reconcile it too.
          void connectEvents(session.id);
        }
        if (agentState?.state) {
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          reconcileCompaction(agentState.state);
          if (agentState.state.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(agentState.state.autoCompactionEnabled);
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
        }
      });
    }
    return () => {
      if (authReconnectTimerRef.current !== null) clearTimeout(authReconnectTimerRef.current);
      authReconnectTimerRef.current = null;
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
      if (!agentState || sessionIdRef.current !== sid) return;
      if (agentState?.state) {
        if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
        if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
        if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
        reconcileCompaction(agentState.state);
        if (agentState.state.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(agentState.state.autoCompactionEnabled);
      }
      if (agentState?.running && agentState.state?.isStreaming) {
        setAgentRunning(true);
        if (!agentStartedAt) setAgentStartedAt(Date.now());
        lastEventAtRef.current = Date.now();
        resetRunProgress();
      } else if (agentRunningRef.current && !agentState.state?.isStreaming) {
        // The run finished while we were away — the "end" event was lost, so
        // reflect idle now instead of showing a stuck spinner.
        streamScheduler.cancel();
        setAgentRunning(false);
        agentRunningRef.current = false;
        setAgentPhase(null);
        setAgentStartedAt(null);
        dispatch({ type: "end" });
      }
      // Even an alive but idle wrapper may have emitted the final events while
      // hidden. Reopen with the cursor to recover them and reconcile a snapshot.
      if (agentState.running) void connectEvents(sid, true);
    });
  }, [agentStartedAt, connectEvents, lastEventAtRef, loadSession, resetRunProgress, reconcileCompaction, streamScheduler]);

  useEffect(() => {
    const onVisibility = () => {
      // Timer delivery can be delayed while backgrounded; publish the latest
      // queued progress immediately on either visibility transition.
      streamScheduler.flush();
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
  }, [resync, streamScheduler]);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  const getGenerationMetrics = useCallback((message: AgentMessage) =>
    generationMetrics.get(sessionIdRef.current, message), [generationMetrics]);

  return {
    // State
    data, loading, error, runtimeFailure, activeLeafId, messages, entryIds, streamState,
    getGenerationMetrics,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, availableTools, customToolNames, thinkingLevel,
    catalogStatus, catalogError, catalogDiagnostics, retryModelCatalog,
    retryInfo, providerRecovery, autoProviderFallback, ephemeralNewSession, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, autoCompactionEnabled, autoCompactionUpdating, currentModel, displayModel, sessionStats,
    compactionSettings: compactionSettings ? { ...compactionSettings, enabled: autoCompactionEnabled ?? compactionSettings.enabled } : null,
    compactionStatus: compaction.view, compactionQueue: compaction.queue,
    handleRetryCompaction: compaction.retry,
    handleCheckCompaction: compaction.check, handleDismissCompaction: compaction.dismiss, handleClearCompactionQueue: compaction.clearQueue,
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

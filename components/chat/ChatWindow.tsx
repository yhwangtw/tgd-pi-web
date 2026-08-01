"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, SessionInfo, SessionTreeNode, ToolResultMessage } from "@/lib/types";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle, type MessageQuote } from "./ChatInput";
import { ExtensionUIPanel, ExtensionWidgets } from "./ExtensionUIPanel";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { BashBlock } from "./BashBlock";
import { CollapsibleMessage } from "./CollapsibleMessage";
import { TgdPipeline, type PhaseStatus } from "./TgdPipeline";
import { CompactionSummary, getCompactionSummary } from "./CompactionSummary";
import { pickTurnTarget } from "./turn-nav";
import { getAlwaysFollow } from "@/lib/prefs";
import { useAgentSession, type AgentPhase } from "@/hooks/useAgentSession";
import { getRunError } from "@/hooks/use-agent-session-types";
import { useAudio } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";
import styles from "./ChatWindow.module.css";
import { useI18n, type MsgKey } from "@/lib/i18n";
import { QueuedFollowUps } from "./QueuedFollowUps";
import { isProviderAuthError } from "./AssistantMessageView";
import { buildConversationLayout } from "./conversation-turns";
import { assistantModelKey, shouldShowAssistantModelLabel } from "./message-chrome";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onSessionNamed?: () => void;
  // Parallel-view support: when set, ChatWindow renders a compact header
  // showing paneLabel and a close button (when onClosePane is provided).
  isParallel?: boolean;
  paneLabel?: string;
  onClosePane?: () => void;
  /** Wide-layout preference (⌘K → Toggle Wide Chat). */
  wideChat?: boolean;
  onOpenModels?: () => void;
}

export function phaseLabel(phase: AgentPhase, translate?: (key: MsgKey) => string): string {
  if (!translate) {
    if (phase?.kind === "running_tools") {
      const names = phase.tools.map((tool) => tool.name);
      if (names.length === 0) return "Running tool...";
      if (names.length === 1) return `Running ${names[0]}...`;
      if (names.length <= 3) return `Running ${names.join(", ")}...`;
      return `Running ${names.slice(0, 2).join(", ")} (+${names.length - 2})...`;
    }
    if (phase?.kind === "waiting_model") return "Waiting for model...";
    return "Thinking...";
  }
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    const running = translate?.("chat.runningStatus") ?? "Running";
    if (names.length === 0) return `${running} tool…`;
    if (names.length === 1) return `${running} ${names[0]}…`;
    if (names.length <= 3) return `${running} ${names.join(", ")}…`;
    return `${running} ${names.slice(0, 2).join(", ")} (+${names.length - 2})…`;
  }
  if (phase?.kind === "waiting_model") return translate?.("chat.waitingModel") ?? "Waiting for model...";
  return translate?.("chat.thinkingStatus") ?? "Thinking...";
}

const phaseSvg = (paths: React.ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {paths}
  </svg>
);

const PHASE_ACTIONS: { cmd: string; label: string; labelKey: MsgKey; descKey: MsgKey; icon: React.ReactNode }[] = [
  {
    cmd: "/tgd-map", label: "Map", labelKey: "phase.label.map", descKey: "phase.map" as MsgKey,
    icon: phaseSvg(<><polygon points="1 6 8 3 16 6 23 3 23 18 16 21 8 18 1 21" /><line x1="8" y1="3" x2="8" y2="18" /><line x1="16" y1="6" x2="16" y2="21" /></>),
  },
  {
    cmd: "/tgd-define", label: "Define", labelKey: "phase.label.define", descKey: "phase.define" as MsgKey,
    icon: phaseSvg(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></>),
  },
  {
    cmd: "/tgd-plan", label: "Plan", labelKey: "phase.label.plan", descKey: "phase.plan" as MsgKey,
    icon: phaseSvg(<><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></>),
  },
  {
    cmd: "/tgd-develop", label: "Develop", labelKey: "phase.label.develop", descKey: "phase.develop" as MsgKey,
    icon: phaseSvg(<><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>),
  },
  {
    cmd: "/tgd-verify", label: "Verify", labelKey: "phase.label.verify", descKey: "phase.verify" as MsgKey,
    icon: phaseSvg(<><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>),
  },
  {
    cmd: "/tgd-review", label: "Review", labelKey: "phase.label.review", descKey: "phase.review" as MsgKey,
    icon: phaseSvg(<><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>),
  },
  {
    cmd: "/tgd-release", label: "Release", labelKey: "phase.label.release", descKey: "phase.release" as MsgKey,
    icon: phaseSvg(<><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9" /></>),
  },
];

const CMD_ORDER = PHASE_ACTIONS.map((p) => p.cmd);

// Client-side shape of the /api/tgd/artifacts response (subset we use).
interface TgdArtifactsClient {
  exists: boolean;
  top: { name: string; phase?: string }[];
  features: { name: string; phasesDone: string[]; mtimeMs: number }[];
}

export function artifactPhaseCommands(
  top: { name: string; phase?: string }[],
  currentFeature: { phasesDone: string[] } | null,
): Set<string> {
  const evidence = new Set<string>();
  if (top.some((file) => file.phase === "map")) evidence.add("/tgd-map");
  if (top.some((file) => file.name === "TRACKING-PLAN.md")) evidence.add("/tgd-plan");

  for (const phase of currentFeature?.phasesDone ?? []) {
    if (phase !== "develop") evidence.add(`/tgd-${phase}`);
  }

  return new Set(CMD_ORDER.filter((command) => evidence.has(command)));
}

const TYPEWRITER_PHRASES = [
  "ready when you are.",
  "ask me anything.",
  "let's build something cool.",
  "explore your codebase.",
  "draft an email.",
  "summarize that paper.",
  "plan your weekend.",
  "explain it like I'm five.",
  "pair-program with me.",
  "fix that pesky bug.",
  "translate to 中文.",
  "write a haiku.",
  "brainstorm ideas.",
  "review my pull request.",
  "what should we cook tonight?",
  "ship it.",
  "make it pretty.",
  "rubber-duck with me.",
];

function Typewriter({ phrases }: { phrases: string[] }) {
  const [phraseIdx, setPhraseIdx] = useState(() => Math.floor(Math.random() * phrases.length));
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [caretOn, setCaretOn] = useState(true);

  useEffect(() => {
    const blink = setInterval(() => setCaretOn((v) => !v), 530);
    return () => clearInterval(blink);
  }, []);

  useEffect(() => {
    const current = phrases[phraseIdx];
    let timeout: ReturnType<typeof setTimeout>;
    if (!deleting && text === current) {
      timeout = setTimeout(() => setDeleting(true), 1800);
    } else if (deleting && text === "") {
      setDeleting(false);
      setPhraseIdx((i) => (i + 1) % phrases.length);
    } else {
      const next = deleting ? current.slice(0, text.length - 1) : current.slice(0, text.length + 1);
      timeout = setTimeout(() => setText(next), deleting ? 28 : 55);
    }
    return () => clearTimeout(timeout);
  }, [text, deleting, phraseIdx, phrases]);

  return (
    <span className={styles.typewriterText}>
      {text}
      <span style={{ opacity: caretOn ? 1 : 0 }} className={styles.typewriterCaret}>▍</span>
    </span>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  const label = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  return <span className="tabular-nums text-[var(--text-dim)]">· {label}</span>;
}

/** Plain-text view of a message for in-conversation search. */
function messageText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string; thinking?: string }>)
    .map((b) => b.text ?? b.thinking ?? "")
    .join(" ");
}

type FindScope = "all" | "user" | "assistant" | "tools" | "errors";

function activityText(messages: import("@/lib/types").AssistantMessage[], toolResults: Map<string, ToolResultMessage>): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.errorMessage) parts.push(message.errorMessage);
    for (const block of message.content) {
      if (block.type === "thinking") parts.push(block.thinking);
      if (block.type === "toolCall") {
        parts.push(block.toolName, JSON.stringify(block.input));
        const result = toolResults.get(block.toolCallId);
        if (result) parts.push(messageText(result));
      }
    }
  }
  return parts.join(" ");
}

export function ChatWindow({ session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsChange, onContextUsageChange, onSessionNamed, isParallel, paneLabel, onClosePane, wideChat, onOpenModels }: Props) {
  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, autoCompactionEnabled, autoCompactionUpdating, displayModel: displayModelValue, sessionStats,
    agentPhase, agentStartedAt, queuedFollowUps, queueUpdating, bashRun, stalledSecs, extensionUIState,
    isNew,
    messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleAutoCompactionChange, handleSteer, handleFollowUp, handleAbortCompaction,
    handleUpdateQueued, handleMoveQueued,
    handleToolPresetChange, handleThinkingLevelChange, handleClearQueue, handleRemoveQueued, handleRetry, handleEditRerun, handleAbortBash, handleExtensionUIResponse, handleAgentEventRef,
  } = useAgentSession({
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionNamed,
  });

  const { t } = useI18n();

  // ── tGD pipeline: detect which phases have run in this session ──
  const [pipelineHidden, setPipelineHidden] = useState(false);
  const [idlePipelineExpanded, setIdlePipelineExpanded] = useState(false);
  useEffect(() => { setPipelineHidden(localStorage.getItem("pi-tgd-pipeline-hidden") === "1"); }, []);
  const hidePipeline = useCallback(() => { setPipelineHidden(true); setIdlePipelineExpanded(false); localStorage.setItem("pi-tgd-pipeline-hidden", "1"); }, []);
  const showPipeline = useCallback(() => { setPipelineHidden(false); setIdlePipelineExpanded(true); localStorage.removeItem("pi-tgd-pipeline-hidden"); }, []);

  const tgdPhases = useMemo(
    () => PHASE_ACTIONS.map((p) => ({ cmd: p.cmd, label: t(p.labelKey), desc: t(p.descKey), icon: p.icon })),
    [t],
  );
  // Transcript signal: which /tgd-* were invoked this session, the last one
  // (live "current"), and the last feature token typed alongside a command.
  const tgdState = useMemo(() => {
    const invoked = new Set<string>();
    let current: string | null = null;
    let featureToken: string | null = null;
    for (const m of messages) {
      if (m.role !== "user") continue;
      const c = (m as { content?: unknown }).content;
      const text = typeof c === "string"
        ? c
        : Array.isArray(c) ? (c as Array<{ type?: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ") : "";
      const match = text.trim().match(/^\/(tgd-\w+)(?:\s+(\S+))?/);
      if (match) {
        const cmd = `/${match[1]}`;
        if (PHASE_ACTIONS.some((p) => p.cmd === cmd)) {
          invoked.add(cmd);
          current = cmd;
          if (match[2]) featureToken = match[2];
        }
      }
    }
    return { invoked, current, featureToken };
  }, [messages]);

  // Disk truth: read real tGD artifacts so "done" means the artifact exists,
  // not merely that the slash command was typed. Only map/define/plan leave
  // artifacts in the tGD dir; develop/verify/review/release act on the code
  // repo, so those stay transcript-driven (hybrid below). Refetch on cwd
  // change and whenever the agent stops (artifacts appear after it writes).
  const tgdCwd = session?.cwd ?? newSessionCwd ?? null;
  const [tgdArtifacts, setTgdArtifacts] = useState<TgdArtifactsClient | null>(null);
  useEffect(() => {
    if (!tgdCwd) { setTgdArtifacts(null); return; }
    let cancelled = false;
    fetch(`/api/tgd/artifacts?cwd=${encodeURIComponent(tgdCwd)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TgdArtifactsClient | null) => { if (!cancelled) setTgdArtifacts(d && d.exists ? d : null); })
      .catch(() => { /* leave transcript-only */ });
    return () => { cancelled = true; };
  }, [tgdCwd, agentRunning]);

  // The "current feature" whose progress the bar reflects: the one named in the
  // last /tgd-* command if it matches, else the most-recently-touched feature.
  const currentFeature = useMemo(() => {
    const features = tgdArtifacts?.features ?? [];
    if (features.length === 0) return null;
    if (tgdState.featureToken) {
      const hit = features.find((f) => f.name === tgdState.featureToken);
      if (hit) return hit;
    }
    return features.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  }, [tgdArtifacts, tgdState.featureToken]);

  // Phases with real on-disk evidence for the current feature. Develop remains
  // transcript-driven because it produces code rather than a tGD document.
  const diskDone = useMemo(() => {
    const top = tgdArtifacts?.top ?? [];
    return artifactPhaseCommands(top, currentFeature);
  }, [tgdArtifacts, currentFeature]);

  const phaseStatusOf = useCallback((cmd: string): PhaseStatus => {
    // Evidence = disk artifacts ∪ this session's invoked commands.
    const done = new Set<string>([...diskDone, ...tgdState.invoked]);
    // Current = the command you last ran live; else the next phase after the
    // furthest one with evidence (so a fresh project highlights Map as "start").
    let current = tgdState.current;
    if (!current) {
      let lastIdx = -1;
      CMD_ORDER.forEach((c, i) => { if (done.has(c)) lastIdx = i; });
      current = lastIdx + 1 < CMD_ORDER.length ? CMD_ORDER[lastIdx + 1] : null;
    }
    if (cmd === current) return "current";
    return done.has(cmd) ? "done" : "todo";
  }, [diskDone, tgdState]);
  const runPhase = useCallback((cmd: string) => {
    chatInputRef?.current?.setText(cmd + " ");
  }, [chatInputRef]);
  const activeTgdRun = useMemo(() => {
    if (!agentRunning) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user") continue;
      return /^\/tgd-\w+\b/.test(messageText(messages[i]).trim());
    }
    return false;
  }, [agentRunning, messages]);
  const pipelineRelevant = activeTgdRun
    || tgdState.invoked.size > 0
    || diskDone.size > 0
    || currentFeature !== null;

  const { soundEnabled, onSoundToggle, playDoneSound } = useAudio();
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  // Wrap agent event handler to play sound on agent_end
  const origHandler = handleAgentEventRef.current;
  useEffect(() => {
    handleAgentEventRef.current = (event) => {
      if (event.type === "agent_end" && soundEnabledRef.current && !getRunError(event)) {
        playDoneSoundRef.current();
      }
      origHandler?.(event);
    };
  }, [origHandler, handleAgentEventRef]);

  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? `${sessionStats.tokens.input}|${sessionStats.tokens.output}|${sessionStats.tokens.cacheRead}|${sessionStats.tokens.cacheWrite}|${sessionStats.cost ?? 0}`
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const onDrop = useCallback((files: File[]) => {
    chatInputRef?.current?.addImages(files);
  }, [chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const conversationLayout = useMemo(() => buildConversationLayout(messages), [messages]);
  const visibleMessages = useMemo(
    () => conversationLayout.displayIndices.map((index) => messages[index]),
    [conversationLayout.displayIndices, messages],
  );
  const messageRefs = useMessageRefs(visibleMessages.length);

  // Scope quotes to the session that created them instead of clearing from an
  // effect. Session context can settle in more than one render after loading;
  // an effect-based reset could race a quote click during that window.
  const [messageQuoteState, setMessageQuoteState] = useState<{
    sessionId: string | undefined;
    quote: MessageQuote;
  } | null>(null);
  const messageQuote = messageQuoteState && messageQuoteState.sessionId === session?.id
    ? messageQuoteState.quote
    : null;
  const openQuotedMessage = useCallback((entryId: string) => {
    const target = document.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(entryId)}"]`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    target?.animate(
      [{ boxShadow: "0 0 0 3px var(--color-accent-border)" }, { boxShadow: "0 0 0 3px transparent" }],
      { duration: 1200, easing: "ease-out" },
    );
  }, []);

  // ── Message bookmarks (per session, persisted) ──────────────────────────
  const bookmarkStorageKey = session?.id ? `pi-bookmarks:${session.id}` : null;
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!bookmarkStorageKey) {
      setBookmarks(new Set());
      return;
    }
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(bookmarkStorageKey) ?? "[]");
      setBookmarks(new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []));
    } catch {
      setBookmarks(new Set());
    }
  }, [bookmarkStorageKey]);
  const toggleBookmark = useCallback((entryId: string) => {
    setBookmarks((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      if (bookmarkStorageKey) {
        try { localStorage.setItem(bookmarkStorageKey, JSON.stringify([...next])); } catch { /* ignore */ }
      }
      return next;
    });
  }, [bookmarkStorageKey]);

  // Visible-message indices that are bookmarked — the minimap marks them.
  const bookmarkedIndices = useMemo(() => {
    const set = new Set<number>();
    conversationLayout.displayIndices.forEach((idx, visIdx) => {
      const id = entryIds[idx];
      if (id && bookmarks.has(id)) set.add(visIdx);
    });
    return set;
  }, [conversationLayout.displayIndices, entryIds, bookmarks]);

  const lastReadStorageKey = session?.id ? `pi-last-read:${session.id}` : null;
  const [unreadMessageIndex, setUnreadMessageIndex] = useState<number | null>(null);
  useEffect(() => {
    if (!lastReadStorageKey || conversationLayout.displayIndices.length === 0) {
      setUnreadMessageIndex(null);
      return;
    }
    const lastReadId = localStorage.getItem(lastReadStorageKey);
    if (!lastReadId) { setUnreadMessageIndex(null); return; }
    const lastReadIndex = entryIds.indexOf(lastReadId);
    if (lastReadIndex < 0) { setUnreadMessageIndex(null); return; }
    const next = conversationLayout.displayIndices.find((index) => index > lastReadIndex && !!entryIds[index]);
    setUnreadMessageIndex(next ?? null);
  }, [conversationLayout.displayIndices, entryIds, lastReadStorageKey]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !lastReadStorageKey) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      const bottom = container.getBoundingClientRect().bottom;
      let lastVisibleId: string | undefined;
      conversationLayout.displayIndices.forEach((messageIndex, visibleIndex) => {
        const element = messageRefs.current[visibleIndex];
        if (element && element.getBoundingClientRect().top < bottom - 12 && entryIds[messageIndex]) {
          lastVisibleId = entryIds[messageIndex];
        }
      });
      if (lastVisibleId) localStorage.setItem(lastReadStorageKey, lastVisibleId);
    };
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, 500);
    };
    const onPageHide = () => save();
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onPageHide);
    return () => {
      if (timer) clearTimeout(timer);
      save();
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [conversationLayout.displayIndices, entryIds, lastReadStorageKey, messageRefs, scrollContainerRef]);

  // ── Long-message collapse ────────────────────────────────────────────────
  // Historical messages taller than a threshold clamp to a preview; the
  // current turn (last user message onward) always renders in full. Keys are
  // the same entry-id-or-index keys the list uses, so expansion survives
  // streaming re-renders.
  const [expandedKeys, setExpandedKeys] = useState<Set<string | number>>(new Set());
  const toggleExpanded = useCallback((key: string | number) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Stable identities so the memoized MessageView actually skips re-renders
  // during streaming (ChatWindow re-renders on every token event).
  const toolResultsMap = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    return map;
  }, [messages]);

  const historicalAssistantModelKey = useMemo<string | null>(() => {
    for (let i = conversationLayout.displayIndices.length - 1; i >= 0; i--) {
      const message = messages[conversationLayout.displayIndices[i]];
      if (message.role === "assistant") {
        return assistantModelKey(message);
      }
    }
    return null;
  }, [conversationLayout.displayIndices, messages]);

  const handleEditContent = useCallback((content: string) => {
    chatInputRef?.current?.insertIfEmpty(content);
  }, [chatInputRef]);

  // Spacer below the last message while the agent runs, so the newest user
  // message can be scrolled to the top. Measured in an effect — reading
  // clientHeight during render forces synchronous layout.
  const [spacerHeight, setSpacerHeight] = useState<number | null>(null);
  useEffect(() => {
    if (agentRunning && scrollContainerRef.current) {
      setSpacerHeight(scrollContainerRef.current.clientHeight);
    }
  }, [agentRunning, scrollContainerRef]);

  // ── Scroll-to-bottom affordance + streaming follow mode ─────────────────
  // followStreamRef: whether the reader is "at the tail" and wants the view
  // to track incoming tokens. Engaged/disengaged only by user scrolls (and
  // the jump button) — content growth alone never changes intent, so the
  // top-anchored reading position is never captured against the user's will.
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const followStreamRef = useRef(false);
  // "+N lines below" counter: how much new content has accumulated under the
  // viewport while the reader is NOT following a running stream.
  const [newLines, setNewLines] = useState(0);
  const newBaselineRef = useRef(0);
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowJumpToBottom(dist > 300);
      const end = messagesEndRef.current;
      if (end) {
        const containerBottom = el.getBoundingClientRect().bottom;
        const markerTop = end.getBoundingClientRect().top;
        // At the tail = end marker sits in the bottom zone of the viewport.
        // Scrolling up pushes it below the fold → disengage.
        followStreamRef.current = markerTop <= containerBottom + 80 && markerTop >= containerBottom - 250;
        if (followStreamRef.current) {
          newBaselineRef.current = el.scrollHeight;
          setNewLines((v) => (v === 0 ? v : 0));
        }
      }
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef, messagesEndRef, messages.length]);

  // Terminal-style preference: engage follow as soon as a run starts.
  useEffect(() => {
    if (agentRunning && getAlwaysFollow()) followStreamRef.current = true;
  }, [agentRunning]);

  // Re-baseline the "+N" counter whenever layout shifts for non-content
  // reasons: run start/end, the run spacer mounting/resizing, or a historical
  // message being expanded/collapsed. Content growth after this is real.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    newBaselineRef.current = el.scrollHeight;
    setNewLines(0);
  }, [agentRunning, spacerHeight, expandedKeys, scrollContainerRef]);

  // Count new content while streaming without following.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !agentRunning) return;
    if (followStreamRef.current) {
      newBaselineRef.current = el.scrollHeight;
      setNewLines((v) => (v === 0 ? v : 0));
      return;
    }
    const delta = el.scrollHeight - newBaselineRef.current;
    const lines = delta > 12 ? Math.max(1, Math.round(delta / 24)) : 0;
    setNewLines((v) => (v === lines ? v : lines));
  }, [messages, streamState.streamingMessage, agentRunning, scrollContainerRef]);

  const jumpToBottom = useCallback(() => {
    // block:"end" — with the run spacer mounted below the marker, the default
    // block:"start" could scroll the content clean out of the viewport.
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    followStreamRef.current = true;
  }, [messagesEndRef]);

  // Streaming follow: while engaged, keep the tail pinned to the viewport
  // bottom as tokens arrive. Instant (not smooth) — smooth animations queue
  // and jitter at token rate. Only scrolls once the tail escapes the fold,
  // so short content under the top anchor never moves.
  useEffect(() => {
    if (!streamState.streamingMessage || !followStreamRef.current) return;
    const el = scrollContainerRef.current;
    const end = messagesEndRef.current;
    if (!el || !end) return;
    const containerBottom = el.getBoundingClientRect().bottom;
    const markerTop = end.getBoundingClientRect().top;
    if (markerTop > containerBottom) {
      end.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [streamState.streamingMessage, scrollContainerRef, messagesEndRef]);

  // ── ⌘F in-conversation search ────────────────────────────────────────────
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findScope, setFindScope] = useState<FindScope>("all");
  const [findPos, setFindPos] = useState(0);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  const findMatches = useMemo(() => {
    const q = findQuery.trim().toLowerCase();
    if (!q) return [];
    const hits: number[] = [];
    conversationLayout.displayIndices.forEach((messageIndex, visIdx) => {
      const msg = messages[messageIndex];
      const activityMessages = conversationLayout.activityByOwner.get(messageIndex) ?? [];
      const activity = activityText(activityMessages, toolResultsMap);
      const hasError = msg.role === "assistant" && (
        msg.stopReason === "error"
        || activityMessages.some((item) => item.stopReason === "error")
        || activityMessages.some((item) => item.content.some((block) => block.type === "toolCall" && toolResultsMap.get(block.toolCallId)?.isError))
      );
      let haystack = "";
      if (findScope === "all") haystack = `${messageText(msg)} ${activity}`;
      else if (findScope === "user" && msg.role === "user") haystack = messageText(msg);
      else if (findScope === "assistant" && msg.role === "assistant") haystack = messageText(msg);
      else if (findScope === "tools") haystack = activity;
      else if (findScope === "errors" && hasError) haystack = `${messageText(msg)} ${activity}`;
      if (haystack.toLowerCase().includes(q)) hits.push(visIdx);
    });
    return hits;
  }, [conversationLayout.activityByOwner, conversationLayout.displayIndices, findQuery, findScope, messages, toolResultsMap]);

  // Keys of visible messages, parallel to messageRefs — used to auto-expand a
  // collapsed message before jumping a find match into it.
  const visibleKeys = useMemo(() => {
    return conversationLayout.displayIndices.map((index) => entryIds[index] ?? index);
  }, [conversationLayout.displayIndices, entryIds]);

  useEffect(() => {
    const query = findQuery.trim().toLocaleLowerCase();
    if (!query) return;
    type HighlightRegistry = {
      set: (name: string, highlight: unknown) => void;
      delete: (name: string) => boolean;
    };
    type HighlightConstructor = new (...ranges: Range[]) => unknown;
    const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
    const HighlightClass = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
    if (!registry || !HighlightClass) return;

    const roots = findMatches
      .map((matchIndex) => messageRefs.current[matchIndex])
      .filter((root): root is HTMLDivElement => !!root);
    const applyHighlight = () => {
      const ranges: Range[] = [];
      for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          const textNode = node as Text;
          const parent = textNode.parentElement;
          const source = textNode.textContent ?? "";
          if (parent && !parent.closest("button, textarea, input, [aria-hidden='true']")) {
            const lower = source.toLocaleLowerCase();
            let start = lower.indexOf(query);
            while (start !== -1) {
              const range = document.createRange();
              range.setStart(textNode, start);
              range.setEnd(textNode, start + query.length);
              ranges.push(range);
              start = lower.indexOf(query, start + query.length);
            }
          }
          node = walker.nextNode();
        }
      }
      registry.set("conversation-find", new HighlightClass(...ranges));
    };

    applyHighlight();
    // Tool/error scopes can expand the work log after the first match jump.
    // Rebuild ranges when React adds those details without modifying its DOM.
    const observers = roots.map((root) => {
      const observer = new MutationObserver(applyHighlight);
      observer.observe(root, { childList: true, subtree: true });
      return observer;
    });
    return () => {
      observers.forEach((observer) => observer.disconnect());
      registry.delete("conversation-find");
    };
  }, [findMatches, findQuery, messageRefs]);

  const gotoMatch = useCallback((pos: number) => {
    const target = findMatches[pos];
    if (target === undefined) return;
    const key = visibleKeys[target];
    if (key !== undefined) {
      setExpandedKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    }
    // Give a collapsed target a beat to expand before scrolling to it.
    setTimeout(() => {
      const el = messageRefs.current[target];
      if (!el) return;
      if (findScope === "tools" || findScope === "errors") {
        const workLog = [...el.querySelectorAll<HTMLButtonElement>('section > button[aria-expanded]')]
          .find((button) => button.parentElement?.getAttribute("aria-label") === t("chat.workLog"));
        if (workLog?.getAttribute("aria-expanded") === "false") workLog.click();
      }
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.animate(
        [
          { boxShadow: "0 0 0 3px var(--color-accent-border)", borderRadius: "8px" },
          { boxShadow: "0 0 0 3px transparent", borderRadius: "8px" },
        ],
        { duration: 1400, easing: "ease-out" },
      );
    }, 60);
  }, [findMatches, findScope, messageRefs, t, visibleKeys]);

  // ⌥↑ / ⌥↓ — walk between user turns (each jump aligns a user message to
  // the viewport top, mirroring the send-time anchor position).
  useEffect(() => {
    if (isParallel) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      const container = scrollContainerRef.current;
      if (!container) return;
      const cTop = container.getBoundingClientRect().top;
      const els: HTMLElement[] = [];
      const tops: number[] = [];
      let visIdx = 0;
      for (const msg of messages) {
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        const el = messageRefs.current[visIdx];
        if (msg.role === "user" && el) {
          els.push(el);
          tops.push(el.getBoundingClientRect().top - cTop);
        }
        visIdx++;
      }
      const target = pickTurnTarget(tops, e.key === "ArrowUp" ? "prev" : "next");
      if (target === null) return;
      e.preventDefault();
      els[target].scrollIntoView({ block: "start", behavior: "smooth" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isParallel, messages, scrollContainerRef, messageRefs]);

  useEffect(() => {
    if (isParallel) return; // one handler per app — main pane owns ⌘F
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        if (messages.length === 0) return; // nothing to search — let the browser have it
        e.preventDefault();
        setFindOpen(true);
        requestAnimationFrame(() => findInputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isParallel, messages.length]);

  useEffect(() => {
    setFindPos(0);
  }, [findQuery, findScope]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !agentRunning;
  const lastAssistantOutcome = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "assistant") return messages[index] as import("@/lib/types").AssistantMessage;
    }
    return null;
  }, [messages]);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      isStreaming={agentRunning}
      model={displayModelValue}
      modelNames={modelNames}
      modelList={modelList}
      onModelChange={handleModelChange}
      onCompact={session ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      autoCompactionEnabled={session ? autoCompactionEnabled : null}
      autoCompactionUpdating={autoCompactionUpdating}
      onAutoCompactionChange={session ? handleAutoCompactionChange : undefined}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      cwd={tgdCwd}
      persistKey={session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : null)}
      quote={messageQuote}
      onClearQuote={() => setMessageQuoteState(null)}
      onOpenQuote={openQuotedMessage}
      wide={wideChat}
    />
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className={styles.skeletonWrapper}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton-line" style={{ width: `${40 + (i % 3) * 20}%`, marginBottom: 10, marginLeft: i % 2 === 0 ? 0 : 60 }} />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isParallel && (
        <div className={styles.paneHeader}>
          <span className={styles.paneLabel} title={paneLabel}>
            {paneLabel ?? "session"}
          </span>
          {onClosePane && (
            <button onClick={onClosePane} className={styles.paneClose} title={t("chat.closePane")} aria-label={t("chat.closePane")}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      )}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[var(--color-accent-bg)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className={`absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[var(--color-accent-border)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards] ${styles.dropRipple}`}
                style={{ animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_var(--color-accent-glow)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="var(--color-accent-bg)" stroke="var(--color-accent-border)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="var(--color-accent-bg-strong)" stroke="var(--color-accent-border)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="var(--color-accent-bg-strong)" stroke="var(--color-accent-border)" strokeWidth="1.6"/>
            <g stroke="var(--color-accent-border)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {isEmptyNew ? (
        <div className={`${styles.emptyNew} flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8`}>
          <div className={`${styles.emptyNewInner} w-full ${wideChat ? "max-w-[1080px]" : "max-w-[900px]"}`}>
            <div
              className={styles.welcomeHeader}
            >
              <div className={styles.welcomeTitleRow}>
                <span className={styles.piSymbol}>π</span>
                <span className={styles.titleText}>with tGD</span>
                <span className={styles.typewriterContainer}>
                  <Typewriter phrases={TYPEWRITER_PHRASES} />
                </span>
              </div>
              <div className={styles.versionColumn}>
                <span className={styles.versionLabel}>
                  web <span className={styles.versionValue}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <span className={styles.versionLabel}>
                  pi <span className={styles.versionValue}>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
                </span>
              </div>
            </div>
            {/* tGD Phase Quick Actions — stroke icons to match the app's icon system */}
            <div className={styles.quickActionsRow}>
              {PHASE_ACTIONS.map((phase) => (
                <button
                  key={phase.cmd}
                  onClick={() => chatInputRef?.current?.setText(phase.cmd + " ")}
                  className={styles.phaseButton}
                  title={`${phase.cmd} — ${t(phase.descKey)}`}
                >
                  <span className={styles.phaseIcon} aria-hidden>{phase.icon}</span>
                  <span className={styles.phaseLabel}>{t(phase.labelKey)}</span>
                </button>
              ))}
            </div>
            {chatInputElement}
          </div>
        </div>
      ) : (
      <>
      <style>{`::highlight(conversation-find) { background: var(--color-warning-bg-strong); color: var(--text); text-decoration: underline var(--color-warning-border); text-decoration-thickness: 1px; }`}</style>
      {pipelineHidden || (!pipelineRelevant && !idlePipelineExpanded) ? (
        <button onClick={showPipeline} className={styles.pipelineShow} title={t("chat.showPipeline")}>
          tGD · {t("chat.workflow")} ▸
        </button>
      ) : (
        <TgdPipeline phases={tgdPhases} statusOf={phaseStatusOf} onRun={runPhase} onHide={hidePipeline} feature={currentFeature?.name ?? null} active={activeTgdRun} />
      )}
      <div className="relative flex flex-1 overflow-hidden">
        {findOpen && (
          <div className={`${styles.findBar} glass absolute right-4 top-2 z-20 flex items-center gap-1 rounded-lg border px-2 py-1 shadow-[var(--color-shadow-dropdown)]`}>
            <select
              value={findScope}
              onChange={(event) => setFindScope(event.target.value as FindScope)}
              className={styles.findScope}
              aria-label={t("search.scopes")}
            >
              <option value="all">{t("chat.findScope.all")}</option>
              <option value="user">{t("chat.findScope.user")}</option>
              <option value="assistant">{t("chat.findScope.assistant")}</option>
              <option value="tools">{t("chat.findScope.tools")}</option>
              <option value="errors">{t("chat.findScope.errors")}</option>
            </select>
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setFindOpen(false);
                  setFindQuery("");
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (findMatches.length === 0) return;
                  const next = e.shiftKey
                    ? (findPos - 1 + findMatches.length) % findMatches.length
                    : (findPos + 1) % findMatches.length;
                  setFindPos(next);
                  gotoMatch(next);
                }
              }}
              placeholder={t("chat.findPlaceholder")}
              className="w-44 bg-transparent text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
              spellCheck={false}
            />
            <span className="min-w-[34px] text-right text-[11px] tabular-nums text-[var(--text-dim)]">
              {findMatches.length > 0 ? `${findPos + 1}/${findMatches.length}` : findQuery ? "0/0" : ""}
            </span>
            <button
              onClick={() => { if (findMatches.length) { const p = (findPos - 1 + findMatches.length) % findMatches.length; setFindPos(p); gotoMatch(p); } }}
              className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]" aria-label={t("chat.previousMatch")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
            </button>
            <button
              onClick={() => { if (findMatches.length) { const p = (findPos + 1) % findMatches.length; setFindPos(p); gotoMatch(p); } }}
              className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]" aria-label={t("chat.nextMatch")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            <button
              onClick={() => { setFindOpen(false); setFindQuery(""); }}
              className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]" aria-label={t("chat.closeFind")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        )}
        {showJumpToBottom && (
          <button
            onClick={jumpToBottom}
            aria-label={t("chat.jumpBottom")}
            className={`glass absolute bottom-4 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center justify-center rounded-full border text-[var(--text-muted)] shadow-[var(--color-shadow-dropdown)] transition hover:text-[var(--text)] ${agentRunning && newLines > 0 ? "gap-1 px-3" : "w-8"} ${agentRunning ? "!border-[var(--color-accent-border)] text-[var(--accent)]" : ""}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></svg>
            {agentRunning && newLines > 0 && (
              <span className="text-[11.5px] font-medium tabular-nums">
                +{newLines} {t("chat.lines")}
              </span>
            )}
          </button>
        )}
        <div ref={scrollContainerRef} className={`${styles.transcriptScroll} flex-1 overflow-y-auto pt-4 [scrollbar-width:none]`}>
          <div className={`${styles.transcript} mx-auto px-4 ${wideChat ? "max-w-[1080px]" : "max-w-[900px]"}`}>

            {(() => {
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user" && getCompactionSummary(messages[i]) === null) { lastUserIdx = i; break; }
              }
              const recoveredAuthIndices = new Set<number>();
              const laterSuccessfulProviders = new Set<string>();
              let hasLaterAssistantSuccess = false;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role !== "assistant") continue;
                const assistant = messages[i] as import("@/lib/types").AssistantMessage;
                const provider = assistant.provider ?? "";
                if (assistant.stopReason === "error" && isProviderAuthError(assistant.errorMessage)) {
                  if (provider ? laterSuccessfulProviders.has(provider) : hasLaterAssistantSuccess) {
                    recoveredAuthIndices.add(i);
                  }
                  continue;
                }
                if (assistant.stopReason !== "error" && messageText(assistant).trim()) {
                  hasLaterAssistantSuccess = true;
                  if (provider) laterSuccessfulProviders.add(provider);
                }
              }
              let refIdx = 0;
              let seenUserMessage = false;
              let previousAssistantModelKey: string | null = null;
              return messages.map((msg, idx) => {
                const compactionSummary = getCompactionSummary(msg);
                let prevAssistantEntryId: string | undefined;
                if (msg.role === "user" && compactionSummary === null) {
                  for (let j = idx - 1; j >= 0; j--) {
                    if (entryIds[j]) { prevAssistantEntryId = entryIds[j]; break; }
                  }
                }
                const isVisible = conversationLayout.displayIndexSet.has(idx);
                if (msg.role === "assistant" && !isVisible) return null;
                const startsNewTurn = msg.role === "user" && compactionSummary === null && seenUserMessage;
                const currentAssistantModelKey = msg.role === "assistant"
                  ? assistantModelKey(msg)
                  : null;
                const showModelLabel = msg.role === "assistant"
                  && shouldShowAssistantModelLabel(previousAssistantModelKey, msg);
                const currentRefIdx = isVisible ? refIdx++ : -1;
                let showTimestamp = msg.role === "assistant" && conversationLayout.finalAssistantIndices.has(idx);
                if (msg.role === "assistant") {
                  // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                  if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                    showTimestamp = false;
                  }
                }
                const turnIndex = conversationLayout.turnIndexByMessageIndex.get(idx);
                const turn = turnIndex === undefined ? undefined : conversationLayout.turns[turnIndex];
                const turnStartedAt = turn?.userIndex !== null && turn?.userIndex !== undefined
                  ? (messages[turn.userIndex] as AgentMessage & { timestamp?: number }).timestamp
                  : undefined;
                // entryIds is parallel to messages after a session load; freshly
                // streamed messages have no entry id yet, so fall back to index
                // (hex entry ids never collide with numeric keys).
                const key = entryIds[idx] ?? idx;
                const entryId = entryIds[idx];
                const canBookmark = compactionSummary === null
                  && !!entryId
                  && (msg.role === "user" || msg.role === "assistant");
                const isBookmarked = canBookmark && bookmarks.has(entryId);
                const view = compactionSummary !== null ? (
                  <CompactionSummary key={key} summary={compactionSummary} />
                ) : (
                  <MessageView
                    key={key}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    entryId={entryIds[idx]}
                    onFork={agentRunning || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onNavigate={agentRunning ? undefined : handleNavigate}
                    prevAssistantEntryId={agentRunning ? undefined : prevAssistantEntryId}
                    onEditContent={handleEditContent}
                    onEditRerun={agentRunning ? undefined : handleEditRerun}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as import("@/lib/types").AgentMessage & { timestamp?: number }).timestamp : undefined}
                    onOpenModels={onOpenModels}
                    authRecovered={recoveredAuthIndices.has(idx)}
                    showModelLabel={showModelLabel}
                    turnActivityMessages={conversationLayout.activityByOwner.get(idx)}
                    suppressActivityBlocks={conversationLayout.activityAssistantIndices.has(idx)}
                    turnStartedAt={turnStartedAt}
                    usageOverride={conversationLayout.usageByFinalAssistant.get(idx)}
                    showUsage={conversationLayout.finalAssistantIndices.has(idx)}
                    onQuote={entryIds[idx] && (msg.role === "user" || msg.role === "assistant")
                      ? (text) => {
                          const nextQuote: MessageQuote = { entryId: entryIds[idx]!, role: msg.role, text };
                          setMessageQuoteState({ sessionId: session?.id, quote: nextQuote });
                        }
                      : undefined}
                    isBookmarked={isBookmarked}
                    onToggleBookmark={canBookmark ? toggleBookmark : undefined}
                  />
                );
                if (!isVisible) return view;
                if (msg.role === "user" && compactionSummary === null) seenUserMessage = true;
                if (currentAssistantModelKey !== null) previousAssistantModelKey = currentAssistantModelKey;
                // The current turn (last user message onward) never collapses.
                const collapsible = compactionSummary === null && (lastUserIdx === -1 ? idx < messages.length - 1 : idx < lastUserIdx);
                return (
                  <Fragment key={key}>
                    {idx === unreadMessageIndex && (
                      <div className={styles.unreadDivider} role="separator">
                        <span>{t("chat.unread")}</span>
                      </div>
                    )}
                  <div
                    data-message-role={compactionSummary === null ? msg.role : "summary"}
                    data-entry-id={entryId}
                    data-bookmarked={isBookmarked || undefined}
                    data-turn-start={startsNewTurn || undefined}
                    className={`msg-item hover-group relative ${styles.messageItem} ${msg.role === "user" && compactionSummary === null ? styles.messageItemUser : styles.messageItemAssistant} ${startsNewTurn ? styles.turnStart : ""}`}
                    ref={(el) => {
                    messageRefs.current[currentRefIdx] = el;
                    if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
                  }}>
                    <CollapsibleMessage
                      collapsible={collapsible}
                      expanded={expandedKeys.has(key)}
                      onToggle={() => toggleExpanded(key)}
                    >
                      {view}
                    </CollapsibleMessage>
                  </div>
                  </Fragment>
                );
              });
            })()}

            {/* Recovery actions stay next to the interrupted outcome. Earlier
                turns already expose edit/rerun + fork from the user message. */}
            {!agentRunning && (lastAssistantOutcome?.stopReason === "error" || lastAssistantOutcome?.stopReason === "aborted") && (
              <div className={styles.recoveryActions}>
                {lastAssistantOutcome.stopReason === "aborted" && (
                  <button type="button" onClick={() => void handleSend(t("chat.continuePrompt"))}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="9 18 15 12 9 6" /></svg>
                    {t("chat.continue")}
                  </button>
                )}
                <button type="button" onClick={() => void handleRetry()}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
                  {t("chat.retry")}
                </button>
              </div>
            )}

            {bashRun && (
              <BashBlock
                command={bashRun.command}
                output={bashRun.output}
                running={bashRun.running}
                onAbort={bashRun.running ? handleAbortBash : undefined}
              />
            )}

            {streamState.isStreaming && streamState.streamingMessage && (
              <MessageView
                message={streamState.streamingMessage as AgentMessage}
                isStreaming
                modelNames={modelNames}
                toolResults={toolResultsMap}
                showModelLabel={historicalAssistantModelKey !== assistantModelKey(streamState.streamingMessage as { provider?: string; model?: string })}
              />
            )}

            {agentRunning && !streamState.streamingMessage && (
              <div className={`flex items-center gap-2 py-2 text-[13px] ${stalledSecs > 0 ? "text-[var(--color-warning-text-strong)]" : "text-text-muted"}`}>
                {stalledSecs > 0 ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="animate-spin text-[var(--accent)]" aria-hidden>
                    <path d="M21 12a9 9 0 1 1-6.2-8.56" />
                  </svg>
                )}
                <span>
                  {stalledSecs > 0
                    ? `${stalledSecs}s · ${t("chat.stalled")}`
                    : phaseLabel(agentPhase, t)}
                </span>
                {agentStartedAt && <Elapsed since={agentStartedAt} />}
              </div>
            )}

            {/* End marker sits BEFORE the run spacer: follow mode and the jump
                button pin to the tail of real content. If the marker came
                after the spacer, following a stream would park the viewport in
                the spacer's blank space instead of on the streaming text. */}
            <div ref={messagesEndRef} />

            {agentRunning && (
              <div style={{ height: spacerHeight ?? "80vh" }} />
            )}
          </div>
        </div>
        <ChatMinimap
          messages={visibleMessages}
          streamingMessage={streamState.streamingMessage}
          scrollContainer={scrollContainerRef}
          messageRefs={messageRefs}
          bookmarkedIndices={bookmarkedIndices}
        />
      </div>

      <div className={`${styles.composerDock} relative`}>
        {/* Context-pressure nudge: suggest compaction before it's too late */}
        {contextUsage?.percent != null && contextUsage.percent >= 80 && !isCompacting && (
          /* pl-4 pr-[52px]: mirror ChatInput's container padding (right side
             reserves the minimap rail) so the banner's box aligns exactly
             with the composer below instead of sticking out to the right. */
          <div className={`${styles.contextWarningWrap} pb-1 pl-4 pr-[52px]`}>
          <div className={`mx-auto flex items-center gap-2 ${wideChat ? "max-w-[1080px]" : "max-w-[900px]"}`}>
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-1.5 text-[12px] text-[var(--color-warning-text)]">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
              {/* min-w-0 flex-1: a flex child's min-width:auto refuses to shrink,
                  so bare `truncate` never elides — the text collided with the
                  button on narrow screens. The percent is the key info, so it
                  lives outside the truncating span and always stays visible. */}
              <span className="min-w-0 flex-1 truncate" title={t("chat.ctxHigh")}>
                {t("chat.ctxHigh")}
              </span>
              <span className="shrink-0 font-semibold tabular-nums">
                {Math.round(contextUsage.percent)}%
              </span>
              <button
                onClick={handleCompact}
                disabled={agentRunning}
                className="shrink-0 rounded border border-[var(--color-warning-border)] px-2 py-0.5 text-[11px] font-medium hover:bg-[var(--color-warning-bg-strong)] disabled:opacity-50"
              >
                {t("chat.compactNow")}
              </button>
            </div>
          </div>
          </div>
        )}
        <QueuedFollowUps
          items={queuedFollowUps}
          busy={queueUpdating}
          wide={wideChat}
          onRemove={handleRemoveQueued}
          onUpdate={handleUpdateQueued}
          onMove={handleMoveQueued}
          onClear={handleClearQueue}
        />
        <ExtensionUIPanel
          state={extensionUIState}
          onRespond={handleExtensionUIResponse}
          wide={wideChat}
        />
        {chatInputElement}
        <ExtensionWidgets state={extensionUIState} placement="belowEditor" wide={wideChat} />
      </div>
      </>
      )}
    </div>
  );
}

"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { MarkdownBody } from "./MarkdownBody";
import type {
  AssistantMessage,
  ToolResultMessage,
  AssistantContentBlock,
  TextContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";
import { DiffViewMode } from "@/components/layout/text-viewer/DiffViewMode";
import { getLanguage } from "@/lib/file-mime";
import { useI18n } from "@/lib/i18n";
import { ToolRunGroup, type ToolRunItem } from "./ToolRunGroup";
import { TurnActivityGroup } from "./TurnActivityGroup";
import { FocusDialog } from "./FocusDialog";
import type { AssistantUsage } from "@/lib/usage-aggregation";
import { requestOpenFile } from "@/lib/file-links";
import styles from "./AssistantMessageView.module.css";
import { MessageBookmarkAction, MessageBookmarkIndicator } from "./MessageBookmarkAction";

export function isProviderAuthError(errorMessage?: string): boolean {
  return !!errorMessage && /(?:no api key|unauthori[sz]ed|authentication|credential|sign[ -]?in|log[ -]?in|openai-codex)/i.test(errorMessage);
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}

export function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  showTimestamp,
  prevTimestamp,
  onOpenModels,
  authRecovered,
  showModelLabel = true,
  turnActivityMessages,
  suppressActivityBlocks,
  turnStartedAt,
  usageOverride,
  showUsage = true,
  onQuote,
  bookmarkEntryId,
  isBookmarked = false,
  onToggleBookmark,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  onOpenModels?: () => void;
  authRecovered?: boolean;
  showModelLabel?: boolean;
  turnActivityMessages?: AssistantMessage[];
  suppressActivityBlocks?: boolean;
  turnStartedAt?: number;
  usageOverride?: AssistantUsage;
  showUsage?: boolean;
  onQuote?: (text: string) => void;
  bookmarkEntryId?: string;
  isBookmarked?: boolean;
  onToggleBookmark?: (entryId: string) => void;
}) {
  const { t } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const blocks = useMemo(() => message.content ?? [], [message.content]);
  const [copied, setCopied] = useState(false);
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const blocksRef = useRef(blocks);
  const rootRef = useRef<HTMLDivElement>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDetailsElement>(null);
  blocksRef.current = blocks;
  const displayBlocks = useMemo(
    () => suppressActivityBlocks
      ? blocks.filter((block) => block.type !== "thinking" && block.type !== "toolCall")
      : blocks,
    [blocks, suppressActivityBlocks],
  );

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || !message.timestamp) return map;
    for (const [callId, result] of toolResults) {
      if (result.timestamp && message.timestamp) {
        const secs = Math.round((result.timestamp - message.timestamp) / 1000);
        if (secs > 0) map.set(callId, secs);
      }
    }
    return map;
  }, [toolResults, message.timestamp]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const canBookmark = !!bookmarkEntryId && !!onToggleBookmark && !!textContent && !isStreaming;

  const closeActions = useCallback(() => {
    actionsRef.current?.removeAttribute("open");
    setActionsOpen(false);
  }, []);
  useEffect(() => {
    if (!actionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) closeActions();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeActions();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [actionsOpen, closeActions]);

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const quoteContent = () => {
    if (!onQuote) return;
    const selection = window.getSelection();
    const selected = selection?.anchorNode && rootRef.current?.contains(selection.anchorNode)
      ? selection.toString().trim()
      : "";
    onQuote(selected || textContent);
  };

  const activeToolCallId = useMemo(() => {
    if (!isStreaming) return undefined;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block.type === "toolCall" && !toolResults?.has(block.toolCallId)) {
        return block.toolCallId;
      }
    }
    return undefined;
  }, [blocks, isStreaming, toolResults]);

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = Date.now();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const bs = blocksRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      bs.forEach((_, i) => {
        if (!blockStartTimesRef.current.has(i)) blockStartTimesRef.current.set(i, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < bs.length - 1; i++) {
          if (!next.has(i) && blockStartTimesRef.current.has(i)) {
            const start = blockStartTimesRef.current.get(i)!;
            const nextStart = blockStartTimesRef.current.get(i + 1) ?? now;
            next.set(i, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      let chars = 0;
      for (const b of bs) {
        if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
        else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
        else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
      }
      if (chars === 0) return;
      if (streamStartRef.current === null) streamStartRef.current = now;
      const elapsed = (now - streamStartRef.current) / 1000;
      if (elapsed > 0.5) setTps(chars / 4 / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  return (
    <div ref={rootRef} data-testid="assistant-message" className={`hover-group ${styles.messageContainer}`}>
      {/* Model label */}
      {showModelLabel && <div className={styles.modelLabel}>
        {message.provider && (
          <span className={styles.modelName}>{modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}</span>
        )}
        {isStreaming && (() => {
          let chars = 0;
          for (const b of blocks) {
            if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
            else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
            else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
          }
          const est = Math.round(chars / 4);
          return (
            <>

              {est > 0 && (
                <span className={styles.tokenCount} title={t("chat.estimatedTokens")}>
                  <span className={styles.tokenCountInner}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {tps !== null && (() => {
                    const bg = tps >= 50 ? "var(--color-tps-fast)" : tps >= 30 ? "var(--color-tps-good)" : tps >= 15 ? "var(--color-tps-mid)" : "var(--color-tps-slow)";
                    return (
                      <span className={styles.tpsBadge} style={{ background: bg }}>
                        {tps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>}

      <div className={styles.blocksContainer}>
        {turnActivityMessages && turnActivityMessages.length > 0 && (
          <TurnWorkLog messages={turnActivityMessages} toolResults={toolResults} turnStartedAt={turnStartedAt} />
        )}
        {renderBlocks({
          blocks: displayBlocks,
          toolResults,
          isStreaming,
          streamingDurations,
          thinkingDurationFromFile,
          toolCallDurations,
          activeToolCallId,
        })}
      </div>

      {!isStreaming && message.stopReason === "error" && (
        authRecovered && isProviderAuthError(message.errorMessage) ? (
          <details className={styles.recoveredError}>
            <summary className={styles.recoveredErrorSummary}>
              <span className={styles.recoveredIcon} aria-hidden>✓</span>
              <span>{t("chat.authRecovered")}</span>
              <span className={styles.recoveredContext}>{t("chat.earlierConnectionIssue")}</span>
              <svg className={styles.recoveredChevron} width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </summary>
            <div className={styles.recoveredErrorDetail}>{message.errorMessage}</div>
          </details>
        ) : (
        <div className={styles.errorCard} role="alert">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div className={styles.errorBody}>
            <span>{message.errorMessage || t("chat.modelFailed")}</span>
            {isProviderAuthError(message.errorMessage) && (
              onOpenModels ? (
                <button type="button" className={styles.reconnectButton} onClick={onOpenModels}>
                  {t("chat.reconnectModel")}
                </button>
              ) : null
            )}
          </div>
        </div>
        )
      )}
      {!isStreaming && message.stopReason === "aborted" && (
        <div className={styles.abortedNote}>{t("chat.stopped")}</div>
      )}

      <div data-testid="assistant-message-footer" className={styles.footer}>
        {showUsage && (usageOverride ?? message.usage) && !isStreaming && (
          <UsageDetails usage={(usageOverride ?? message.usage)!} />
        )}
        {textContent && !isStreaming && <div data-testid="assistant-message-actions" className={styles.actionToolbar}>
        {textContent && !isStreaming && onQuote && (
          <button type="button" onClick={quoteContent} title={t("chat.quote")} className={`${styles.copyButton} text-dim hover-accent`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 21c3-6 7-9 14-9" /><path d="M13 7l5 5-5 5" /></svg>
            <span className={styles.copyLabel}>{t("chat.quote")}</span>
          </button>
        )}
        {textContent && !isStreaming && (
          <button
            onClick={copyContent}
            title={t("chat.copyMessage")}
            className={`${styles.copyButton} ${copied ? "text-accent" : "text-dim hover-accent"}`}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            <span className={styles.copyLabel}>{copied ? t("common.copied") : t("common.copy")}</span>
          </button>
        )}
        {canBookmark && (
          <MessageBookmarkAction
            isBookmarked={isBookmarked}
            onToggle={() => onToggleBookmark!(bookmarkEntryId!)}
            className={styles.copyButton}
          />
        )}
        </div>}
        {textContent && !isStreaming && (
          <details ref={actionsRef} className={styles.mobileActionMenu}>
            <summary role="button" title={t("chat.moreActions")} aria-label={t("chat.moreActions")} onClick={() => setActionsOpen(!(actionsRef.current?.open ?? false))}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
              </svg>
            </summary>
            <div className={styles.mobileActionPanel}>
              {onQuote && (
                <button type="button" onClick={() => { closeActions(); quoteContent(); }} className={`${styles.copyButton} text-dim hover-accent`}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 21c3-6 7-9 14-9" /><path d="M13 7l5 5-5 5" /></svg>
                  <span>{t("chat.quote")}</span>
                </button>
              )}
              <button type="button" onClick={() => { closeActions(); copyContent(); }} className={`${styles.copyButton} ${copied ? "text-accent" : "text-dim hover-accent"}`}>
                {copied ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                )}
                <span>{copied ? t("common.copied") : t("common.copy")}</span>
              </button>
              {canBookmark && (
                <MessageBookmarkAction
                  isBookmarked={isBookmarked}
                  onToggle={() => { closeActions(); onToggleBookmark!(bookmarkEntryId!); }}
                  className={styles.copyButton}
                />
              )}
            </div>
          </details>
        )}
        <MessageBookmarkIndicator isBookmarked={canBookmark && isBookmarked} />
        {time && !isStreaming && (
          <span className={styles.timestamp}>{time}</span>
        )}
      </div>
    </div>
  );

function TurnWorkLog({
  messages,
  toolResults,
  turnStartedAt,
}: {
  messages: AssistantMessage[];
  toolResults?: Map<string, ToolResultMessage>;
  turnStartedAt?: number;
}) {
  const entries = messages.flatMap((activityMessage) =>
    activityMessage.content
      .filter((block) => block.type === "thinking" || block.type === "toolCall")
      .map((block, index) => ({ activityMessage, block, index })),
  );
  const toolEntries = entries.filter(
    (entry): entry is typeof entry & { block: ToolCallContent } => entry.block.type === "toolCall",
  );
  const files = new Set<string>();
  let failed = messages.filter((activityMessage) => activityMessage.stopReason === "error").length;
  let lastTimestamp = Math.max(0, ...messages.map((activityMessage) => activityMessage.timestamp ?? 0));
  for (const entry of toolEntries) {
    const path = entry.block.input && typeof entry.block.input.path === "string" ? entry.block.input.path : null;
    if (path && (entry.block.toolName === "edit" || entry.block.toolName === "write")) files.add(path);
    const result = toolResults?.get(entry.block.toolCallId);
    if (result?.isError) failed += 1;
    if (result?.timestamp) lastTimestamp = Math.max(lastTimestamp, result.timestamp);
  }
  const firstTimestamp = turnStartedAt
    ?? Math.min(...messages.map((activityMessage) => activityMessage.timestamp ?? Number.POSITIVE_INFINITY));
  const elapsed = Number.isFinite(firstTimestamp) && lastTimestamp > firstTimestamp
    ? Math.max(1, Math.round((lastTimestamp - firstTimestamp) / 1000))
    : undefined;

  return (
    <TurnActivityGroup
      steps={entries.length}
      tools={toolEntries.length}
      filesChanged={files.size}
      failed={failed}
      elapsed={elapsed}
    >
      {entries.map(({ activityMessage, block, index }) => {
        if (block.type === "thinking") {
          return <ThinkingBlock key={`thinking-${activityMessage.timestamp ?? 0}-${index}`} block={block} />;
        }
        const result = toolResults?.get(block.toolCallId);
        const duration = result?.timestamp && activityMessage.timestamp
          ? Math.max(1, Math.round((result.timestamp - activityMessage.timestamp) / 1000))
          : undefined;
        return <ToolCallBlock key={block.toolCallId} block={block} result={result} duration={duration} />;
      })}
    </TurnActivityGroup>
  );
}

function renderBlocks({
  blocks,
  toolResults,
  isStreaming,
  streamingDurations,
  thinkingDurationFromFile,
  toolCallDurations,
  activeToolCallId,
}: {
  blocks: AssistantContentBlock[];
  toolResults?: Map<string, ToolResultMessage>;
  isStreaming?: boolean;
  streamingDurations: Map<number, number>;
  thinkingDurationFromFile?: number;
  toolCallDurations: Map<string, number>;
  activeToolCallId?: string;
}) {
  const rendered: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length;) {
    const block = blocks[i];
    if (block.type !== "toolCall") {
      rendered.push(
        <BlockView
          key={i}
          block={block}
          isStreaming={isStreaming}
          streamingDuration={streamingDurations.get(i) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)}
        />,
      );
      i += 1;
      continue;
    }

    let end = i + 1;
    while (end < blocks.length && blocks[end].type === "toolCall") end += 1;
    const run = blocks.slice(i, end) as ToolCallContent[];
    const items: ToolRunItem[] = run.map((tool) => ({
      block: tool,
      result: toolResults?.get(tool.toolCallId),
      duration: toolCallDurations.get(tool.toolCallId),
    }));

    if (items.length > 1) {
      rendered.push(
        <ToolRunGroup key={`tools-${i}`} items={items} activeToolCallId={activeToolCallId}>
          {items.map((item) => (
            <ToolCallBlock
              key={item.block.toolCallId}
              block={item.block}
              result={item.result}
              duration={item.duration}
              active={item.block.toolCallId === activeToolCallId}
            />
          ))}
        </ToolRunGroup>,
      );
    } else {
      const item = items[0];
      rendered.push(
        <ToolCallBlock
          key={item.block.toolCallId || i}
          block={item.block}
          result={item.result}
          duration={item.duration}
          active={item.block.toolCallId === activeToolCallId}
        />,
      );
    }
    i = end;
  }
  return rendered;
}

function BlockView({ block, isStreaming, streamingDuration }: { block: AssistantContentBlock; isStreaming?: boolean; streamingDuration?: number }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} />;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} />;
  }
  return null;
}

function TextBlock({ block, isStreaming }: { block: TextContent; isStreaming?: boolean }) {
  return <MarkdownBody isStreaming={isStreaming}>{block.text}</MarkdownBody>;
}

function ThinkingBlock({ block, duration }: { block: ThinkingContent; duration?: number }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  return (
    <div className={styles.thinkingContainer}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className={styles.thinkingButton}
        aria-expanded={expanded}
      >
        <span>{t("chat.thinking")}</span>
        {duration !== undefined && (
          <span className={styles.thinkingDuration}>{duration}s</span>
        )}
      </button>
      {expanded && (
        <div className={styles.thinkingExpanded}>
          {block.thinking}
        </div>
      )}
    </div>
  );
}


function ToolCallBlock({ block, result, duration, active = false }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number; active?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const { t } = useI18n();
  const inputStr = JSON.stringify(block.input, null, 2);

  // pi's file tools get structured rendering instead of raw JSON:
  // edit {path, oldText, newText} → a real diff; write {path, content} → the
  // written content. Anything else falls back to pretty-printed args.
  const input = (block.input ?? {}) as Record<string, unknown>;
  const isEditTool = block.toolName === "edit"
    && typeof input.oldText === "string" && typeof input.newText === "string";
  const isWriteTool = block.toolName === "write" && typeof input.content === "string";
  const toolPath = typeof input.path === "string" ? input.path : "";

  // Result display
  const resultText = result
    ? result.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = result?.isError ?? false;

  return (
    <div
      className={`${styles.toolCallContainer} ${isError ? styles.toolCallContainerError : active ? styles.toolCallContainerRunning : styles.toolCallContainerSuccess}`}
    >
      {/* ── Tool call header ── */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className={styles.toolCallButton}
        aria-expanded={expanded}
      >
        <span className={`${styles.toolName} ${isError ? styles.toolNameError : active ? styles.toolNameRunning : styles.toolNameSuccess}`}>
          {block.toolName}
        </span>
        <span className={styles.toolPreview}>
          {getToolPreview(block)}
        </span>
        {active && <span className={styles.toolRunningText}>{t("chat.runningTool")}</span>}
        {duration !== undefined && (
          <span className={styles.toolDuration}>{duration}s</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={styles.toolChevron} style={{ transform: expanded ? "rotate(180deg)" : "none" }}>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {/* ── Expanded: structured view for file tools, JSON otherwise ── */}
      {expanded && isEditTool && (
        <div className={styles.toolDiffWrap}>
          {toolPath && <ToolDiffHeader path={toolPath} onFocus={() => setFocusOpen(true)} />}
          <DiffViewMode
            oldContent={input.oldText as string}
            newContent={input.newText as string}
            language={getLanguage(toolPath)}
          />
        </div>
      )}
      {expanded && isWriteTool && (
        <div className={styles.toolDiffWrap}>
          {toolPath && <ToolDiffHeader path={toolPath} onFocus={() => setFocusOpen(true)} />}
          <DiffViewMode
            oldContent=""
            newContent={input.content as string}
            language={getLanguage(toolPath)}
          />
        </div>
      )}
      {expanded && !isEditTool && !isWriteTool && (
        <pre
          className={`${styles.toolInputPre} ${isError ? styles.toolInputPreError : styles.toolInputPreSuccess}`}
        >
          {inputStr}
        </pre>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && (
        <PairedResult
          text={resultText ?? ""}
          isEmpty={resultIsEmpty}
          isError={isError}
        />
      )}
      {(isEditTool || isWriteTool) && (
        <FocusDialog open={focusOpen} title={toolPath || block.toolName} onClose={() => setFocusOpen(false)}>
          <div className={styles.focusDiff}>
            <DiffViewMode
              oldContent={isEditTool ? input.oldText as string : ""}
              newContent={isEditTool ? input.newText as string : input.content as string}
              language={getLanguage(toolPath)}
            />
          </div>
        </FocusDialog>
      )}
    </div>
  );
}

function ToolDiffHeader({ path, onFocus }: { path: string; onFocus: () => void }) {
  const { t } = useI18n();
  return (
    <div className={`${styles.toolDiffPath} chrome-mono`}>
      <button type="button" className={styles.toolDiffOpen} onClick={() => requestOpenFile({ path })} title={path}>{path}</button>
      <button type="button" onClick={onFocus} title={t("code.focus")} aria-label={t("code.focus")}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 3H3v5M16 21h5v-5M3 8l5-5M21 16l-5 5" /></svg>
      </button>
    </div>
  );
}

function PairedResult({ text, isEmpty, isError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  return (
    <div
      className={`${styles.pairedResult} ${isError ? styles.pairedResultError : ""}`}
    >
      <pre
        className={`${styles.pairedResultPre} ${isEmpty ? styles.pairedResultPreEmpty : ""} ${isError ? styles.pairedResultPreError : ""}`}
      >
        {isEmpty ? "(no output)" : text}
      </pre>
    </div>
  );
}

function UsageDetails({ usage }: { usage: NonNullable<AssistantMessage["usage"]> }) {
  const { t } = useI18n();
  const details = formatUsage(usage);
  return (
    <details className={styles.usageDetails}>
      <summary title={details}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <span>{t("chat.usage")}</span>
      </summary>
      <span className={styles.usagePopover}>{details}</span>
    </details>
  );
}


function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): string {
  const parts = [];
  if (usage.input) parts.push(`${usage.input.toLocaleString()} in`);
  if (usage.output) parts.push(`${usage.output.toLocaleString()} out`);
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} cache`);
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}
}

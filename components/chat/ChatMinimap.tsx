"use client";

import { useEffect, useRef, useState, useCallback, useMemo, RefObject } from "react";
import type { AgentMessage, AssistantMessage, TextContent } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import styles from "./ChatMinimap.module.css";

interface Props {
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  /** Visible-message indices carrying a bookmark — marked amber. */
  bookmarkedIndices?: Set<number>;
}

const MINIMAP_WIDTH = 36;

function getMessagePreview(msg: AgentMessage | Partial<AgentMessage>): string {
  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") return content.slice(0, 200);
    if (Array.isArray(content)) {
      return (content as { type: string; text?: string }[])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n")
        .slice(0, 200);
    }
    return "";
  }
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    const text = blocks
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    if (text) return text.slice(0, 200);
    const toolNames = blocks
      .filter((b) => b.type === "toolCall")
      .map((b) => (b as { type: string; toolName: string }).toolName);
    if (toolNames.length) return toolNames.join(", ");
    return "";
  }
  return "";
}

function getNodeColor(msg: AgentMessage | Partial<AgentMessage>): { bg: string; border: string } {
  if (msg.role === "user") {
    return { bg: "var(--color-accent-bg-strong)", border: "var(--color-accent-border)" };
  }
  return { bg: "var(--color-accent-bg)", border: "var(--color-accent-border)" };
}

function hasTextContent(msg: AgentMessage | Partial<AgentMessage>): boolean {
  if (msg.role === "user") return true;
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    return blocks.some((b) => b.type === "text");
  }
  return false;
}

interface NodeInfo {
  topRatio: number;   // 0–1 within total scroll height
  heightRatio: number;
  msg: AgentMessage | Partial<AgentMessage>;
  index: number;
  messageIndex: number;
  /** Index among visible (user/assistant) messages — bookmark lookup key. */
  visIdx: number;
}

export function ChatMinimap({ messages, streamingMessage, scrollContainer, messageRefs, bookmarkedIndices }: Props) {
  const { t } = useI18n();
  const [scrollRatio, setScrollRatio] = useState(0);
  const [viewportRatio, setViewportRatio] = useState(1);
  const [visible, setVisible] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const draggingRef = useRef<{ id: number; element: HTMLDivElement; top: number; height: number; offset: number } | null>(null);
  const previewCache = useRef(new WeakMap<object, string>());
  const previewOf = (node: NodeInfo) => {
    const message = allMessages[node.messageIndex] ?? node.msg;
    if (message === streamingMessage) return getMessagePreview(message);
    const cached = previewCache.current.get(message);
    if (cached !== undefined) return cached;
    const text = getMessagePreview(message);
    previewCache.current.set(message, text);
    return text;
  };
  const containerRef = useRef<HTMLDivElement>(null);

  const allMessages = useMemo(
    () => (streamingMessage ? [...messages, streamingMessage] : messages) as (AgentMessage | Partial<AgentMessage>)[],
    [messages, streamingMessage]
  );
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  const updateViewportRef = useRef<() => void>(null!);
  updateViewportRef.current = () => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;

    const totalH = scrollEl.scrollHeight;
    const clientH = scrollEl.clientHeight;
    const scrollable = totalH - clientH;

    setVisible(scrollable > 20);
    if (scrollable <= 0) {
      setScrollRatio(0);
      setViewportRatio(1);
    } else {
      setScrollRatio(scrollEl.scrollTop / scrollable);
      setViewportRatio(clientH / totalH);
    }
  };

  const updatePositionsRef = useRef<() => void>(null!);
  updatePositionsRef.current = () => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    updateViewportRef.current();
    const totalH = scrollEl.scrollHeight;
    // Read the container once, before the row measurements. Scrolling does
    // not change absolute row positions, so only layout changes run this pass.
    const containerTop = scrollEl.getBoundingClientRect().top;
    const scrollTop = scrollEl.scrollTop;

    // Build node positions from real DOM refs
    const refs = messageRefs.current;
    const newNodes: NodeInfo[] = [];
    let refIndex = 0;

    const allMessages = allMessagesRef.current;
    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i];
      if (msg.role !== "user" && msg.role !== "assistant") continue;

      const el = refs?.[refIndex];
      const visIdx = refIndex;
      refIndex++;

      if (!hasTextContent(msg)) continue;

      if (el && totalH > 0) {
        const elRect = el.getBoundingClientRect();
        const top = elRect.top - containerTop + scrollTop;
        const h = elRect.height;
        newNodes.push({
          topRatio: top / totalH,
          heightRatio: h / totalH,
          msg,
          index: newNodes.length,
          messageIndex: i,
          visIdx,
        });
      }
    }
    setNodes((previous) => previous.length === newNodes.length && previous.every((node, index) => {
      const next = newNodes[index];
      return node.msg === next.msg && node.visIdx === next.visIdx && node.messageIndex === next.messageIndex
        && node.topRatio === next.topRatio && node.heightRatio === next.heightRatio;
    }) ? previous : newNodes);
  };

  const frameRef = useRef<number | null>(null);
  const measurePendingRef = useRef(false);
  const scheduleUpdate = useCallback((measurePositions: boolean) => {
    measurePendingRef.current ||= measurePositions;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const measure = measurePendingRef.current;
      measurePendingRef.current = false;
      if (measure) updatePositionsRef.current();
      else updateViewportRef.current();
    });
  }, []);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const onScroll = () => scheduleUpdate(false);
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => scheduleUpdate(true));
    ro.observe(el);
    // Also observe the scroll content for height changes
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    scheduleUpdate(true);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      measurePendingRef.current = false;
    };
  }, [scrollContainer, scheduleUpdate]);

  // Same-length session/branch replacements also need fresh nodes. Stream
  // content resizes are covered by the observer without scanning on every token.
  const hasStreamingMessage = !!streamingMessage;
  useEffect(() => {
    scheduleUpdate(true);
  }, [messages, hasStreamingMessage, scheduleUpdate]);

  const scrollToMinimapRatio = useCallback((viewportTopRatio: number) => {
    const el = scrollContainer.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight;
    if (scrollable <= 0) return;
    const clamped = Math.max(0, Math.min(1 - viewportRatio, viewportTopRatio));
    el.scrollTop = (clamped / (1 - viewportRatio)) * scrollable;
  }, [scrollContainer, viewportRatio]);

  const finishDrag = useCallback(() => {
    const drag = draggingRef.current;
    draggingRef.current = null;
    if (drag?.element.hasPointerCapture(drag.id)) drag.element.releasePointerCapture(drag.id);
  }, []);

  useEffect(() => {
    window.addEventListener("blur", finishDrag);
    return () => { window.removeEventListener("blur", finishDrag); finishDrag(); };
  }, [finishDrag]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!visible || e.button !== 0 || e.isPrimary === false || draggingRef.current) return;
    if ((e.target as HTMLElement).closest("button")) return;

    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.height <= 0) return;
    const clickRatio = (e.clientY - rect.top) / rect.height;
    const grabOffset = clickRatio - scrollRatio * (1 - viewportRatio);
    const insideBox = grabOffset >= 0 && grabOffset <= viewportRatio;
    const offset = insideBox ? grabOffset : viewportRatio / 2;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = { id: e.pointerId, element: e.currentTarget, top: rect.top, height: rect.height, offset };
    scrollToMinimapRatio(clickRatio - offset);
  }, [visible, viewportRatio, scrollRatio, scrollToMinimapRatio]);

  if (!visible) return null;

  const viewportBoxTop = scrollRatio * (1 - viewportRatio) * 100;
  const viewportBoxHeight = viewportRatio * 100;

  // Find the node closest to the current mouse position
  const nearestIndex = mouseYRatio !== null && nodes.length > 0
    ? nodes.reduce((best, node) => {
        return Math.abs(node.topRatio - mouseYRatio) < Math.abs(nodes[best].topRatio - mouseYRatio) ? node.index : best;
      }, 0)
    : null;
  // One preview follows the pointer or keyboard focus. Rendering a preview for
  // every historical message obscures the transcript and grows the DOM needlessly.
  const previewNode = nodes[focusedIndex ?? nearestIndex ?? -1];
  const preview = previewNode ? previewOf(previewNode) : "";
  const minimapHeight = containerRef.current?.clientHeight ?? 600;
  const previewTop = previewNode ? Math.max(0, Math.min(minimapHeight - 36, previewNode.topRatio * minimapHeight - 18)) : 0;

  return (
    <div
      ref={containerRef}
      className={`hover-group ${styles.container}`}
      role="navigation"
      aria-label={t("chat.messageMap")}
      onPointerDown={handlePointerDown}
      onPointerUp={(e) => { if (draggingRef.current?.id === e.pointerId) finishDrag(); }}
      onPointerCancel={(e) => { if (draggingRef.current?.id === e.pointerId) finishDrag(); }}
      onLostPointerCapture={(e) => { if (draggingRef.current?.id === e.pointerId) finishDrag(); }}
      onPointerLeave={() => { setMouseYRatio(null); }}
      onPointerMove={(e) => {
        const drag = draggingRef.current;
        if (drag) {
          if (drag.id === e.pointerId) scrollToMinimapRatio((e.clientY - drag.top) / drag.height - drag.offset);
          return;
        }
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.height > 0) setMouseYRatio((e.clientY - rect.top) / rect.height);
      }}
      style={{ width: MINIMAP_WIDTH }}
    >
      {/* Viewport indicator */}
      <div
        className={styles.viewportIndicator}
        style={{
          top: `${viewportBoxTop}%`,
          height: `${viewportBoxHeight}%`,
        }}
      />

      {/* Message nodes */}
      {nodes.map((node) => {
        const nodePreview = previewOf(node);
        const bookmarked = bookmarkedIndices?.has(node.visIdx) ?? false;
        const color = bookmarked
          ? { bg: "var(--color-warning-text-strong)", border: "var(--color-warning-text-strong)" }
          : getNodeColor(node.msg);
        const isNearest = nearestIndex === node.index;
        const isUser = node.msg.role === "user";
        const inViewport = node.topRatio + node.heightRatio >= scrollRatio * (1 - viewportRatio)
          && node.topRatio <= scrollRatio * (1 - viewportRatio) + viewportRatio;
        const dotTop = node.topRatio * 100;

        return (
          <button
            key={node.index}
            type="button"
            className={styles.node}
            data-minimap-message-index={node.visIdx}
            style={{ top: `${dotTop}%` }}
            aria-label={`${t(isUser ? "minimap.jumpUser" : "minimap.jumpAssistant").replace("{index}", String(node.visIdx + 1))}${nodePreview ? `: ${nodePreview.replace(/\s+/g, " ").slice(0, 64)}` : ""}`}
            onFocus={() => setFocusedIndex(node.index)}
            onBlur={() => setFocusedIndex(null)}
            onKeyDown={(event) => {
              const next = event.key === "ArrowDown" ? Math.min(node.index + 1, nodes.length - 1)
                : event.key === "ArrowUp" ? Math.max(node.index - 1, 0)
                : event.key === "Home" ? 0 : event.key === "End" ? nodes.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              containerRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
            }}
            onClick={(event) => {
              event.stopPropagation();
              // Dense histories have overlapping hit areas. Pointer clicks
              // follow the preview nearest that point; keyboard clicks keep
              // the explicitly focused message as their target.
              const rect = containerRef.current?.getBoundingClientRect();
              const ratio = rect && rect.height > 0 ? (event.clientY - rect.top) / rect.height : null;
              const target = event.detail > 0 && ratio !== null
                ? nodes.reduce((best, candidate) => Math.abs(candidate.topRatio - ratio) < Math.abs(best.topRatio - ratio) ? candidate : best, node)
                : node;
              messageRefs.current?.[target.visIdx]?.scrollIntoView({ block: "start", behavior: "auto" });
            }}
          >
            {/* Dot */}
            <div
              className={[
                styles.dot,
                isUser ? styles.dotUser : styles.dotAssistant,
                isNearest || focusedIndex === node.index ? styles.dotNearest : styles.dotNormal,
                inViewport || bookmarked ? styles.dotHighlighted : "",
              ].join(" ")}
              style={{
                background: color.bg,
                border: `1.5px solid ${color.border}`,
              }}
            />


          </button>
        );
      })}

      {/* Center line */}
      <div className={styles.centerLine} />

      {preview && <div className={styles.tooltipLayer} aria-hidden="true">
        <div className={`${styles.tooltip} ${styles.tooltipNearest} ${focusedIndex !== null ? styles.tooltipFocused : ""}`} style={{ top: previewTop, border: "1px solid var(--border)" }}>
          <div className={`${styles.tooltipText} ${styles.tooltipTextNearest}`}>{preview}</div>
        </div>
      </div>}
    </div>
  );
}

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  // Token renders keep both the ref and its array stable; only resize on commits.
  if (refs.current.length > count) refs.current.length = count;
  while (refs.current.length < count) refs.current.push(null);
  return refs;
}

"use client";

import { useEffect, useRef, useState, useCallback, useMemo, RefObject } from "react";
import type { AgentMessage, AssistantMessage, TextContent } from "@/lib/types";
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
  /** Index among visible (user/assistant) messages — bookmark lookup key. */
  visIdx: number;
}

export function ChatMinimap({ messages, streamingMessage, scrollContainer, messageRefs, bookmarkedIndices }: Props) {
  const [scrollRatio, setScrollRatio] = useState(0);
  const [viewportRatio, setViewportRatio] = useState(1);
  const [visible, setVisible] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const allMessages = useMemo(
    () => (streamingMessage ? [...messages, streamingMessage] : messages) as (AgentMessage | Partial<AgentMessage>)[],
    [messages, streamingMessage]
  );
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  const updatePositionsRef = useRef<() => void>(null!);
  updatePositionsRef.current = () => {
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
        const containerRect = scrollEl.getBoundingClientRect();
        const top = elRect.top - containerRect.top + scrollEl.scrollTop;
        const h = elRect.height;
        newNodes.push({
          topRatio: top / totalH,
          heightRatio: h / totalH,
          msg,
          index: newNodes.length,
          visIdx,
        });
      }
    }
    setNodes(newNodes);
  };

  const updatePositions = useCallback(() => updatePositionsRef.current(), []);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    el.addEventListener("scroll", updatePositions, { passive: true });
    const ro = new ResizeObserver(updatePositions);
    ro.observe(el);
    // Also observe the scroll content for height changes
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    updatePositions();
    return () => {
      el.removeEventListener("scroll", updatePositions);
      ro.disconnect();
    };
  }, [scrollContainer, updatePositions]);

  // Re-measure when message count changes (new messages arrive)
  useEffect(() => {
    const t = setTimeout(updatePositions, 50);
    return () => clearTimeout(t);
  }, [messages.length, updatePositions]);

  const scrollToMinimapRatio = useCallback((viewportTopRatio: number) => {
    const el = scrollContainer.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight;
    if (scrollable <= 0) return;
    const clamped = Math.max(0, Math.min(1 - viewportRatio, viewportTopRatio));
    el.scrollTop = (clamped / (1 - viewportRatio)) * scrollable;
  }, [scrollContainer, viewportRatio]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!visible) return;
    if ((e.target as HTMLElement).closest("button")) return;

    draggingRef.current = true;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickRatio = (e.clientY - rect.top) / rect.height;
    const grabOffset = clickRatio - scrollRatio * (1 - viewportRatio);
    const insideBox = grabOffset >= 0 && grabOffset <= viewportRatio;
    const offset = insideBox ? grabOffset : viewportRatio / 2;

    scrollToMinimapRatio(clickRatio - offset);

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const r = (ev.clientY - rect.top) / rect.height;
      scrollToMinimapRatio(r - offset);
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [visible, viewportRatio, scrollRatio, scrollToMinimapRatio]);




  // Compute collision-free tooltip positions for all nodes
  const TOOLTIP_HEIGHT = 22;
  const TOOLTIP_GAP = 2;
  const minimapHeightPx = containerRef.current?.clientHeight ?? 600;

  const tooltipPositions = useMemo(() => {
    if (nodes.length === 0) return [];
    // Initial positions: centered on the dot
    const positions = nodes.map((node) =>
      Math.round(node.topRatio * minimapHeightPx - TOOLTIP_HEIGHT / 2)
    );
    // Iterative push-apart to resolve overlaps (top-to-bottom pass, then bottom-to-top)
    for (let pass = 0; pass < 10; pass++) {
      for (let i = 1; i < positions.length; i++) {
        const minTop = positions[i - 1] + TOOLTIP_HEIGHT + TOOLTIP_GAP;
        if (positions[i] < minTop) positions[i] = minTop;
      }
      for (let i = positions.length - 2; i >= 0; i--) {
        const maxTop = positions[i + 1] - TOOLTIP_HEIGHT - TOOLTIP_GAP;
        if (positions[i] > maxTop) positions[i] = maxTop;
      }
    }
    // Clamp all to minimap bounds
    for (let i = 0; i < positions.length; i++) {
      positions[i] = Math.max(0, Math.min(minimapHeightPx - TOOLTIP_HEIGHT, positions[i]));
    }
    return positions;
  }, [nodes, minimapHeightPx]);

  if (!visible) return null;

  const viewportBoxTop = scrollRatio * (1 - viewportRatio) * 100;
  const viewportBoxHeight = viewportRatio * 100;

  // Find the node closest to the current mouse position
  const nearestIndex = mouseYRatio !== null && nodes.length > 0
    ? nodes.reduce((best, node) => {
        return Math.abs(node.topRatio - mouseYRatio) < Math.abs(nodes[best].topRatio - mouseYRatio) ? node.index : best;
      }, 0)
    : null;

  return (
    <div
      ref={containerRef}
      className={`hover-group ${styles.container}`}
      onMouseDown={handleMouseDown}
      onMouseLeave={() => { setMouseYRatio(null); }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setMouseYRatio((e.clientY - rect.top) / rect.height);
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
        const bookmarked = bookmarkedIndices?.has(node.visIdx) ?? false;
        const color = bookmarked
          ? { bg: "var(--color-warning-text-strong)", border: "var(--color-warning-text-strong)" }
          : getNodeColor(node.msg);
        const isNearest = nearestIndex === node.index;
        const isUser = node.msg.role === "user";
        const dotTop = node.topRatio * 100;

        return (
          <button
            key={node.index}
            type="button"
            className={styles.node}
            style={{ top: `${dotTop}%` }}
            aria-label={`Jump to ${isUser ? "user" : "assistant"} message ${node.visIdx + 1}${getMessagePreview(node.msg) ? `: ${getMessagePreview(node.msg).replace(/\s+/g, " ").slice(0, 64)}` : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              messageRefs.current?.[node.visIdx]?.scrollIntoView({ block: "start", behavior: "auto" });
            }}
          >
            {/* Dot */}
            <div
              className={[
                styles.dot,
                isUser ? styles.dotUser : styles.dotAssistant,
                isNearest ? styles.dotNearest : styles.dotNormal,
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

      {/* Tooltips for all nodes, collision-free positions — shown on hover via CSS */}
      <div className={`hover-reveal ${styles.tooltipLayer}`}>
        {nodes.map((node, i) => {
          const preview = getMessagePreview(node.msg);
          const color = getNodeColor(node.msg);
          const isNearest = nearestIndex === node.index;
          if (!preview || tooltipPositions.length === 0) return null;
          return (
            <div
              key={node.index}
              className={`${styles.tooltip} ${isNearest ? styles.tooltipNearest : styles.tooltipFar}`}
              style={{
                top: tooltipPositions[i],
                borderTop: `1px solid ${isNearest ? color.border : "var(--border)"}`,
                borderRight: `1px solid ${isNearest ? color.border : "var(--border)"}`,
                borderBottom: `1px solid ${isNearest ? color.border : "var(--border)"}`,
                borderLeft: `2px solid ${color.border}`,
              }}
            >
              <div
                className={`${styles.tooltipText} ${isNearest ? styles.tooltipTextNearest : styles.tooltipTextFar}`}
              >
                {preview}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}

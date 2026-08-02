"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { SessionEntry, SessionTreeNode } from "@/lib/types";
import styles from "./BranchNavigator.module.css";
import { useI18n } from "@/lib/i18n";

interface Props {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  /** When true, renders as a compact inline button for embedding in a top bar */
  inline?: boolean;
  /** When inline, use this ref's bounding rect to size/position the dropdown */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Controlled open state for inline mode */
  open?: boolean;
  /** Called when the button is clicked in inline mode */
  onToggle?: () => void;
  /** Whether a session is currently active (used to show appropriate empty reason) */
  hasSession?: boolean;
  /** Keep the controlled dropdown mounted while another control owns its trigger. */
  hideTrigger?: boolean;
}

// Find the set of entry IDs on the path from root to activeLeafId
function buildActivePath(nodes: SessionTreeNode[], targetId: string | null): Set<string> {
  if (!targetId) return new Set();
  function search(nodes: SessionTreeNode[], path: string[]): string[] | null {
    for (const node of nodes) {
      const next = [...path, node.entry.id];
      if (node.entry.id === targetId) return next;
      const found = search(node.children, next);
      if (found) return found;
    }
    return null;
  }
  return new Set(search(nodes, []) ?? []);
}

// Compress a linear chain into the first branching/leaf node.
// Returns the representative node to display, plus a count of skipped nodes.
function compress(node: SessionTreeNode): { node: SessionTreeNode; skipped: number } {
  let current = node;
  let skipped = 0;
  while (current.children.length === 1) {
    current = current.children[0];
    skipped++;
  }
  return { node: current, skipped };
}

function getLabel(entry: SessionEntry): string {
  if (entry.type === "message" && "message" in entry) {
    const msg = entry.message as { role: string; content: unknown };
    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ");
    }
    if (text.length > 40) text = text.slice(0, 40) + "…";
    if (text) return text;
    if (msg.role === "assistant") return "[assistant]";
  }
  return entry.type;
}

// Does the tree have any branching at all? A populated tree can still be a
// purely linear history, which should not expose a dead "Branches" action.
export function hasSessionBranches(nodes: SessionTreeNode[]): boolean {
  for (const node of nodes) {
    if (node.children.length > 1) return true;
    if (hasSessionBranches(node.children)) return true;
  }
  return false;
}

interface TreeNodeProps {
  node: SessionTreeNode;
  activePathIds: Set<string>;
  depth: number;
  isLast: boolean;
  parentLines: boolean[]; // whether ancestor at each depth has more siblings after
  onSelect: (id: string) => void;
}

function TreeNodeView({ node, activePathIds, depth, isLast, parentLines, onSelect }: TreeNodeProps) {
  const { node: rep, skipped } = compress(node);
  const isActive = activePathIds.has(rep.entry.id);
  const isOnPath = activePathIds.has(node.entry.id) || activePathIds.has(rep.entry.id);
  const label = getLabel(rep.entry);
  const role = rep.entry.type === "message" && "message" in rep.entry
    ? (rep.entry.message as { role: string }).role
    : null;

  return (
    <div>
      {/* This node row */}
      <div
        className={styles.nodeRow}
        onClick={() => onSelect(rep.entry.id)}
      >
        {/* Indent guide lines */}
        {parentLines.map((hasLine, i) => (
          <div key={i} className={styles.indentColumn}>
            {hasLine && (
              <div className={styles.indentLine} />
            )}
          </div>
        ))}

        {/* Branch connector */}
        <div className={styles.connectorColumn}>
          {/* vertical line up (to parent) */}
          <div
            className={isLast ? styles.verticalLineToMiddle : styles.verticalLineToBottom}
          />
          {/* horizontal line to node */}
          <div className={styles.horizontalLine} />
        </div>

        {/* Node dot */}
        <div className={isActive ? styles.nodeDotActive : isOnPath ? styles.nodeDotOnPath : styles.nodeDotInactive} />

        {/* Role badge */}
        {role && (
          <span className={role === "user" ? styles.roleBadgeUser : styles.roleBadgeAssistant}>
            {role === "user" ? "U" : "A"}
          </span>
        )}

        {/* Skipped indicator */}
        {skipped > 0 && (
          <span className={styles.skippedIndicator}>
            +{skipped}
          </span>
        )}

        {/* Label */}
        <span className={isActive ? styles.nodeLabelActive : isOnPath ? styles.nodeLabelOnPath : styles.nodeLabelInactive}>
          {label}
        </span>
      </div>

      {/* Children */}
      {rep.children.map((child, idx) => (
        <TreeNodeView
          key={child.entry.id}
          node={child}
          activePathIds={activePathIds}
          depth={depth + 1}
          isLast={idx === rep.children.length - 1}
          parentLines={[...parentLines, !isLast]}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function BranchNavigator({ tree, activeLeafId, onLeafChange, inline, containerRef, open: openProp, onToggle, hasSession, hideTrigger = false }: Props) {
  const { t } = useI18n();
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp !== undefined ? openProp : openInternal;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open || !inline) return;
    const anchor = containerRef?.current ?? btnRef.current;
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      // Clamp within the viewport so the panel never runs off the right edge
      // (the top bar can be wider than the screen on narrow layouts).
      const margin = 8;
      const width = Math.min(rect.width, window.innerWidth - margin * 2);
      let left = rect.left;
      if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
      if (left < margin) left = margin;
      setDropdownPos({ top: rect.bottom, left, width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(anchor);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, inline, containerRef]);

  const activePathIds = useMemo(
    () => buildActivePath(tree, activeLeafId),
    [tree, activeLeafId]
  );

  const handleSelect = useCallback((id: string) => {
    onLeafChange(id);
  }, [onLeafChange]);

  const noBranchReason = !hasSession
    ? "No active session"
    : !hasSessionBranches(tree)
      ? "This session has no branches"
      : null;

  // Find first meaningful node (skip pure linear prefix)
  const compressed = tree.length > 0 ? compress(tree[0]) : null;
  const firstNode = compressed?.node ?? null;
  const hasContent = !noBranchReason && firstNode && firstNode.children.length > 1;

  const branchIcon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={hasContent ? styles.branchIconActive : styles.branchIconInactive}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );

  const chevron = (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={styles.chevron} style={{ transform: open ? "rotate(180deg)" : "none" }}>
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );


  // AppShell controls this dropdown from its own session menu. When that
  // trigger is hidden and the dropdown is closed, avoid leaving an empty flex
  // item behind — on mobile it otherwise consumes a grid cell and wraps the
  // visible actions onto a second row.
  if (inline && hideTrigger && (!open || !hasContent)) return null;

  if (inline) {
    return (
      <div className={styles.inlineContainer}>
        {!hideTrigger && (
          <button
            ref={btnRef}
            onClick={() => onToggle ? onToggle() : setOpenInternal((v) => !v)}
            className={open ? styles.inlineButtonOpen : styles.inlineButtonClosed}
          >
            {branchIcon}
            <span>{t("topbar.branches")}</span>
          </button>
        )}
        {open && dropdownPos && typeof document !== "undefined" && createPortal(
          // Portalled to <body>: the top bar has a backdrop-filter, which traps
          // position:fixed children in a stacking context that paints *under*
          // the chat content (the tGD pipeline bar covered this dropdown).
          <div className={styles.inlineDropdown} style={{ top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width }}>
            {hasContent && firstNode ? (
              <div className={styles.dropdownContent}>
                {firstNode.children.map((child, idx) => (
                  <TreeNodeView
                    key={child.entry.id}
                    node={child}
                    activePathIds={activePathIds}
                    depth={0}
                    isLast={idx === firstNode.children.length - 1}
                    parentLines={[]}
                    onSelect={handleSelect}
                  />
                ))}
              </div>
            ) : (
              <div className={styles.dropdownEmpty}>
                {noBranchReason}
              </div>
            )}
          </div>,
          document.body,
        )}
      </div>
    );
  }

  return (
    <div className={styles.standaloneWrapper}>
      {/* Header toggle */}
      <button
        onClick={() => setOpenInternal((v) => !v)}
        className={styles.standaloneHeaderButton}
      >
        {branchIcon}
        <span className={styles.branchesLabel}>{t("topbar.branches")}</span>
        {chevron}
      </button>

      {/* Tree panel - overlay */}
      {open && (
        <div className={styles.standaloneOverlay}>
          {hasContent && firstNode ? (
            <div className={styles.dropdownContent}>
              {firstNode.children.map((child, idx) => (
                <TreeNodeView
                  key={child.entry.id}
                  node={child}
                  activePathIds={activePathIds}
                  depth={0}
                  isLast={idx === firstNode.children.length - 1}
                  parentLines={[]}
                  onSelect={handleSelect}
                />
              ))}
            </div>
          ) : (
            <div className={styles.dropdownEmpty}>
              {noBranchReason ?? "This session has no branches"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

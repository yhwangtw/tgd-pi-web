"use client";
import { useDismissiblePanel } from "@/hooks/useDismissiblePanel";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, GitBranch } from "lucide-react";
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
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

// Parent links avoid recursive traversal and quadratic path copies in long histories.
export function buildActivePath(nodes: SessionTreeNode[], targetId: string | null): Set<string> {
  if (!targetId) return new Set();
  type Path = { id: string; parent: Path | null };
  const stack = nodes.map((node) => ({ node, parent: null as Path | null })).reverse();
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    const path: Path = { id: node.entry.id, parent };
    if (node.entry.id === targetId) {
      const ids = new Set<string>();
      for (let current: Path | null = path; current; current = current.parent) ids.add(current.id);
      return ids;
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i], parent: path });
    }
  }
  return new Set();
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
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.children.length > 1) return true;
    if (node.children.length === 1) stack.push(node.children[0]);
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
      <button
        type="button"
        aria-pressed={isActive}
        aria-label={`${role ?? rep.entry.type}: ${label}`}
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
      </button>

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

export function BranchNavigator({ tree, activeLeafId, onLeafChange, inline, containerRef, open: openProp, onToggle, hasSession, hideTrigger = false, returnFocusRef }: Props) {
  const { t } = useI18n();
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp !== undefined ? openProp : openInternal;
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closePanel = useCallback(() => { if (onToggle) onToggle(); else setOpenInternal(false); }, [onToggle]);
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

  useDismissiblePanel(open && (!inline || dropdownPos !== null), panelRef, closePanel, returnFocusRef ?? btnRef);

  const activePathIds = useMemo(
    () => open ? buildActivePath(tree, activeLeafId) : new Set<string>(),
    [tree, activeLeafId, open]
  );

  const handleSelect = useCallback((id: string) => {
    onLeafChange(id);
    if (onToggle) onToggle(); else setOpenInternal(false);
    const launcher = returnFocusRef?.current ?? btnRef.current;
    (launcher?.matches("button") ? launcher : launcher?.querySelector<HTMLElement>("button"))?.focus();
  }, [onLeafChange, onToggle, returnFocusRef]);

  const hasBranches = useMemo(() => hasSessionBranches(tree), [tree]);
  const noBranchReason = !hasSession
    ? t("session.branch.noneActive")
    : !hasBranches
      ? t("session.branch.none")
      : null;

  // Find first meaningful node (skip pure linear prefix)
  const firstNode = useMemo(() => tree.length > 0 ? compress(tree[0]).node : null, [tree]);
  const hasContent = !noBranchReason && firstNode && firstNode.children.length > 1;

  const branchIcon = <GitBranch size={UI_ICON_SIZE.inline} className={hasContent ? styles.branchIconActive : styles.branchIconInactive} aria-hidden />;

  const chevron = (
    <ChevronDown size={UI_ICON_SIZE.inline} className={styles.chevron} style={{ transform: open ? "rotate(180deg)" : "none" }} aria-hidden />
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
          // the chat content.
          <div ref={panelRef} tabIndex={-1} role="dialog" aria-label={t("topbar.branches")} className={styles.inlineDropdown} style={{ top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width }}>
            {hasContent && firstNode ? (
              <div className={styles.dropdownContent} onKeyDown={event => {
                const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
                const at = items.indexOf(document.activeElement as HTMLButtonElement);
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                }
              }}>
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
        ref={btnRef}
        onClick={() => setOpenInternal((v) => !v)}
        className={styles.standaloneHeaderButton}
      >
        {branchIcon}
        <span className={styles.branchesLabel}>{t("topbar.branches")}</span>
        {chevron}
      </button>

      {/* Tree panel - overlay */}
      {open && (
        <div ref={panelRef} tabIndex={-1} role="dialog" aria-label={t("topbar.branches")} className={styles.standaloneOverlay}>
          {hasContent && firstNode ? (
            <div className={styles.dropdownContent} onKeyDown={event => {
                const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
                const at = items.indexOf(document.activeElement as HTMLButtonElement);
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                }
              }}>
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
              {noBranchReason ?? t("session.branch.none")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

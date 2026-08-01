"use client";

import { useState, useCallback, useRef } from "react";
import type { SessionInfo } from "@/lib/types";
import { formatRelativeTime, getSessionDisplayTitle } from "./session-utils";
import { getTagStyle } from "@/lib/tag-colors";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";
import { SessionContextMenu, type SessionContextMenuPosition } from "./SessionContextMenu";
import styles from "./SessionItem.module.css";

interface SessionItemProps {
  session: SessionInfo;
  isSelected: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isPinned?: boolean;
  onPinToggle?: (id: string) => void;
  tags?: string[];
  onSetTag?: (tag: string) => void;
  onRemoveTag?: (tag: string) => void;
  isParallelOpen?: boolean;
  onOpenParallel?: (session: SessionInfo) => void;
  isArchived?: boolean;
  onArchiveToggle?: (id: string) => void;
}

export function SessionItem({
  session,
  isSelected,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  isPinned = false,
  onPinToggle,
  tags = [],
  onSetTag,
  onRemoveTag,
  isParallelOpen = false,
  onOpenParallel,
  isArchived = false,
  onArchiveToggle,
}: SessionItemProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuPosition | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { theme } = useTheme();
  const { locale, t } = useI18n();

  const title = getSessionDisplayTitle(session, 50);

  const startRename = useCallback(() => {
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed]);

  const handleDeleteConfirm = useCallback(async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, onDeleted, setConfirmDelete, setDeleting]);

  const handleDeleteCancel = useCallback(() => {
    setConfirmDelete(false);
  }, [setConfirmDelete]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleOverflowClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Anchor menu at the right edge of the button so it doesn't fly off the right side
    setContextMenu({ x: Math.round(rect.right), y: Math.round(rect.bottom + 4) });
  }, []);

  const handleTagRemove = useCallback((e: React.MouseEvent, tag: string) => {
    e.stopPropagation();
    onRemoveTag?.(tag);
  }, [onRemoveTag]);

  // Decide whether tags spill into a 3rd grid row
  // - 0-3 tags → inline in meta row
  // - >3 tags → inline shows first 3, remaining go on full row below
  const hasOverflowTags = tags.length > 3;
  const inlineTags = tags.slice(0, 3);
  const overflowTags = tags.slice(3);

  return (
    <>
      <div
        onClick={confirmDelete || renaming ? undefined : onClick}
        onContextMenu={handleContextMenu}
        data-session-row={session.id}
        tabIndex={-1}
        role="option"
        aria-selected={isSelected}
        className={["hover-group", !confirmDelete && !isSelected ? "hover-bg" : "", styles.item].filter(Boolean).join(" ")}
        style={{
          paddingLeft: depth > 0 ? depth * 12 + 14 : 14,
          cursor: confirmDelete || renaming ? "default" : "pointer",
          background: confirmDelete
            ? "var(--color-error-bg)"
            : isSelected ? "var(--color-accent-bg)" : undefined,
          opacity: deleting ? 0.5 : 1,
        }}
      >
        {confirmDelete ? (
          /* ── Delete confirmation: replaces grid with two flat buttons ── */
          <div className={styles.deleteRow}>
            <div className={styles.deleteText}>
              {t("session.deleteConfirm")} <span className={styles.deleteTextBold}>&ldquo;{title.slice(0, 22)}{title.length > 22 ? "…" : ""}&rdquo;</span>?
            </div>
            <div className={styles.deleteActions}>
              <button onClick={handleDeleteConfirm} className={styles.deleteConfirmButton}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                {t("session.delete")}
              </button>
              <button onClick={handleDeleteCancel} className={styles.cancelButton}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : renaming ? (
          /* ── Rename: input fills the grid ── */
          <div className={styles.renameRow}>
            <input
              ref={inputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
              autoFocus
              className={styles.renameInput}
            />
          </div>
        ) : (
          /* ── Normal view: 3-row grid ── */
          <div className={styles.grid}>
            {/* Row 1: title (with optional fork indicator) + overflow + collapse toggle */}
            <div className={styles.titleRow}>
              {depth > 0 && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.forkIndicator}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
              )}
              <div
                className={`${styles.sessionTitle} ${isSelected ? styles.sessionTitleSelected : styles.sessionTitleDefault}`}
                title={title}
              >
                {title}
              </div>
              <div className={styles.titleActions}>
                {isPinned && (
                  <span className={styles.pinDot} title={t("session.pinned")} aria-label={t("session.pinned")}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                  </span>
                )}
                {hasChildren && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
                    title={collapsed ? t("session.expandForks") : t("session.collapseForks")}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? t("session.expandForks") : t("session.collapseForks")}
                    className={`${styles.collapseToggle} ${collapsed ? styles.collapseToggleCollapsed : styles.collapseToggleExpanded}`}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="2 3.5 5 6.5 8 3.5" />
                    </svg>
                  </button>
                )}
                <button
                  onClick={handleOverflowClick}
                  title={t("session.moreActions")}
                  aria-label={t("session.moreActions")}
                  aria-haspopup="menu"
                  aria-expanded={contextMenu !== null}
                  className={`${styles.overflowButton} ${contextMenu ? styles.overflowButtonOpen : ""}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <circle cx="5" cy="12" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="19" cy="12" r="1.6" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Row 2: meta — time + msg count + first 3 tag chips */}
            <div className={styles.metaRow}>
              <span className={styles.metaItem} title={session.modified}>
                {formatRelativeTime(session.modified, locale)}
              </span>
              <span className={styles.metaDivider}>·</span>
              <span className={styles.metaItem}>{session.messageCount} {session.messageCount === 1 ? t("sidebar.msg") : t("sidebar.msgs")}</span>
              {inlineTags.map((tag) => {
                const ts = getTagStyle(tag, theme);
                return (
                  <span
                    key={tag}
                    className={styles.tagChip}
                    title={`#${tag}`}
                    style={{ background: ts.bg, color: ts.fg, borderColor: ts.border }}
                  >
                    #{tag}
                    {onRemoveTag && (
                      <button
                        onClick={(e) => handleTagRemove(e, tag)}
                        className={styles.tagChipRemove}
                        title={`${t("session.removeTag")} #${tag}`}
                        aria-label={`${t("session.removeTag")} #${tag}`}
                      >×</button>
                    )}
                  </span>
                );
              })}
              {hasOverflowTags && (
                <span
                  className={styles.tagOverflow}
                  title={overflowTags.map((t) => `#${t}`).join(" ")}
                >
                  +{overflowTags.length}
                </span>
              )}
            </div>

            {/* Row 3: overflow tag chips full width (only when >3 tags) */}
            {hasOverflowTags && (
              <div className={styles.tagRow} onClick={(e) => e.stopPropagation()}>
                {overflowTags.map((tag) => {
                  const ts = getTagStyle(tag, theme);
                  return (
                    <span
                      key={tag}
                      className={styles.tagChip}
                      style={{ background: ts.bg, color: ts.fg, borderColor: ts.border }}
                    >
                      #{tag}
                      {onRemoveTag && (
                        <button
                          onClick={(e) => handleTagRemove(e, tag)}
                          className={styles.tagChipRemove}
                          title={`${t("session.removeTag")} #${tag}`}
                          aria-label={`${t("session.removeTag")} #${tag}`}
                        >×</button>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {contextMenu && (
        <SessionContextMenu
          position={contextMenu}
          session={session}
          isPinned={isPinned}
          isParallelOpen={isParallelOpen}
          existingTags={tags}
          onClose={closeContextMenu}
          onPinToggle={onPinToggle ?? (() => {})}
          onOpenParallel={onOpenParallel ?? (() => {})}
          onStartRename={startRename}
          onAddTag={onSetTag ?? (() => {})}
          onRemoveTag={onRemoveTag}
          isArchived={isArchived}
          onArchiveToggle={onArchiveToggle}
          onRequestDelete={() => setConfirmDelete(true)}
        />
      )}
    </>
  );
}

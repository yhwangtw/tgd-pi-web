"use client";

import { useState, useCallback, useRef } from "react";
import type { SessionInfo } from "@/lib/types";
import { workspaceStateLabel, type WorkspaceIdentity } from "@/lib/workspace-identity";
import { formatRelativeTime, getSessionDisplayTitle, getSessionPreview, getSessionProjectName } from "./session-utils";
import { getTagStyle } from "@/lib/tag-colors";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";
import { SessionContextMenu, type SessionContextMenuPosition } from "./SessionContextMenu";
import { ChevronDown, GitFork, MoreHorizontal, Pencil, Star, Trash2 } from "lucide-react";
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
  showProject?: boolean;
  displayTitle?: string;
  workspaceIdentity?: WorkspaceIdentity;
  listOrder?: number;
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
  displayTitle,
  workspaceIdentity,
  listOrder,
}: SessionItemProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuPosition | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { locale, t } = useI18n();
  const { theme } = useTheme();

  const title = displayTitle ?? getSessionDisplayTitle(session, 50);
  const preview = getSessionPreview(session);
  const repository = workspaceIdentity?.repository ?? getSessionProjectName(session.cwd);
  const branch = workspaceIdentity?.branch
    ?? t(workspaceIdentity ? workspaceStateLabel(workspaceIdentity) : "topbar.gitLoading");

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

  const handleTagRemove = useCallback((event: React.MouseEvent, tag: string) => {
    event.stopPropagation();
    onRemoveTag?.(tag);
  }, [onRemoveTag]);

  return (
    <>
      <div
        onClick={confirmDelete || renaming ? undefined : onClick}
        onContextMenu={handleContextMenu}
        data-session-row={session.id}
        data-session-order={listOrder}
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
              {t("session.deleteTarget").replace("{name}", `${title.slice(0, 22)}${title.length > 22 ? "…" : ""}`)}
            </div>
            <div className={styles.deleteActions}>
              <button type="button" onClick={handleDeleteConfirm} className={styles.deleteConfirmButton}>
                <Trash2 size={12} strokeWidth={2} aria-hidden="true" />
                {t("session.delete")}
              </button>
              <button type="button" onClick={handleDeleteCancel} className={styles.cancelButton}>
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
          /* ── Normal view: one title line + one scannable context line ── */
          <div className={styles.grid}>
            {/* Row 1: title (with optional fork indicator) + overflow + collapse toggle */}
            <div className={styles.titleRow}>
              {depth > 0 && (
                <GitFork size={13} strokeWidth={1.8} className={styles.forkIndicator} aria-label={t("session.fork")} />
              )}
              <div
                className={`${styles.sessionTitle} ${isSelected ? styles.sessionTitleSelected : styles.sessionTitleDefault}`}
                title={title}
              >
                {title}
              </div>
              <div className={styles.titleActions}>
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); onPinToggle?.(session.id); }}
                  title={isPinned ? t("session.unpin") : t("session.pin")}
                  aria-label={isPinned ? t("session.unpin") : t("session.pin")}
                  aria-pressed={isPinned}
                  className={`${styles.rowAction} ${isPinned ? styles.rowActionPinned : ""}`}
                >
                  <Star size={14} strokeWidth={1.8} fill={isPinned ? "currentColor" : "none"} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); startRename(); }}
                  title={t("session.rename")}
                  aria-label={t("session.rename")}
                  className={styles.rowAction}
                >
                  <Pencil size={14} strokeWidth={1.8} aria-hidden />
                </button>
                {hasChildren && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
                    title={collapsed ? t("session.expandForks") : t("session.collapseForks")}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? t("session.expandForks") : t("session.collapseForks")}
                    className={`${styles.collapseToggle} ${collapsed ? styles.collapseToggleCollapsed : styles.collapseToggleExpanded}`}
                  >
                    <ChevronDown size={14} strokeWidth={1.8} aria-hidden />
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
                  <MoreHorizontal size={15} strokeWidth={1.8} aria-hidden />
                </button>
              </div>
            </div>

            {/* Keep repository identity separate from the conversational excerpt. */}
            <div className={styles.metaRow}>
              <span className={styles.workspaceMeta} title={`${session.cwd} · ${branch}`}>
                <span>{repository}</span>
                <span className={styles.workspaceSlash}>/</span>
                <span className={styles.workspaceBranch}>{branch}</span>
              </span>
              <span className={styles.metaTime} title={session.modified}>{formatRelativeTime(session.modified, locale)}</span>
            </div>
            <div className={styles.previewRow}>
              <span className={styles.preview} title={preview || `${session.messageCount} ${session.messageCount === 1 ? t("sidebar.msg") : t("sidebar.msgs")}`}>
                {preview || `${session.messageCount} ${session.messageCount === 1 ? t("sidebar.msg") : t("sidebar.msgs")}`}
              </span>
              {tags.slice(0, 1).map((tag) => {
                const tagStyle = getTagStyle(tag, theme);
                return (
                  <span
                    key={tag}
                    className={styles.tagChip}
                    title={`#${tag}`}
                    style={{ background: tagStyle.bg, color: tagStyle.fg, borderColor: tagStyle.border }}
                  >
                    #{tag}
                    {onRemoveTag && (
                      <button
                        type="button"
                        onClick={(event) => handleTagRemove(event, tag)}
                        className={styles.tagChipRemove}
                        title={`${t("session.removeTag")} #${tag}`}
                        aria-label={`${t("session.removeTag")} #${tag}`}
                      >×</button>
                    )}
                  </span>
                );
              })}
              {tags.length > 1 && <span className={styles.tagCount} title={tags.slice(1).map((tag) => `#${tag}`).join(" ")}>+{tags.length - 1}</span>}
            </div>
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

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { SessionInfo } from "@/lib/types";
import { getTagStyle } from "@/lib/tag-colors";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";
import styles from "./SessionContextMenu.module.css";

export interface SessionContextMenuPosition {
  x: number;
  y: number;
}

interface SessionContextMenuProps {
  position: SessionContextMenuPosition | null;
  session: SessionInfo;
  isPinned: boolean;
  isParallelOpen: boolean;
  /** Existing tags for this session — used to prevent duplicates in the add-tag input. */
  existingTags: string[];
  onClose: () => void;
  onPinToggle: (id: string) => void;
  onOpenParallel: (session: SessionInfo) => void;
  onStartRename: () => void;
  onAddTag: (tag: string) => void;
  onRemoveTag?: (tag: string) => void;
  isArchived?: boolean;
  onArchiveToggle?: (id: string) => void;
  onRequestDelete: () => void;
}

export function SessionContextMenu({
  position,
  session,
  isPinned,
  isParallelOpen,
  existingTags,
  onClose,
  onPinToggle,
  onOpenParallel,
  onStartRename,
  onAddTag,
  onRemoveTag,
  isArchived = false,
  onArchiveToggle,
  onRequestDelete,
}: SessionContextMenuProps) {
  const { theme } = useTheme();
  const { t } = useI18n();
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);

  // Close on outside-click and ESC
  useEffect(() => {
    if (!position) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [position, onClose]);

  // Focus the tag input when entering add-tag mode
  useEffect(() => {
    if (addingTag) {
      setTimeout(() => tagInputRef.current?.focus(), 0);
    }
  }, [addingTag]);

  // Clamp the menu to the viewport so it never opens off-screen
  const [clampedPos, setClampedPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!position) {
      setClampedPos(null);
      return;
    }
    // First measure the menu, then clamp
    const MENU_W = 200;
    const MENU_H = (addingTag ? 250 : 210) + (existingTags.length > 0 ? 34 : 0);
    const padding = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = position.x;
    let top = position.y;
    if (left + MENU_W + padding > vw) left = Math.max(padding, vw - MENU_W - padding);
    if (top + MENU_H + padding > vh) top = Math.max(padding, vh - MENU_H - padding);
    setClampedPos({ left, top });
  }, [position, addingTag, existingTags.length]);

  const runAndClose = useCallback(
    (fn: () => void) => {
      fn();
      onClose();
    },
    [onClose],
  );

  const handlePin = useCallback(() => {
    runAndClose(() => onPinToggle(session.id));
  }, [runAndClose, onPinToggle, session.id]);

  const handleParallel = useCallback(() => {
    runAndClose(() => onOpenParallel(session));
  }, [runAndClose, onOpenParallel, session]);

  const handleRename = useCallback(() => {
    runAndClose(() => onStartRename());
  }, [runAndClose, onStartRename]);

  const handleDelete = useCallback(() => {
    runAndClose(() => onRequestDelete());
  }, [runAndClose, onRequestDelete]);

  const handleArchive = useCallback(() => {
    runAndClose(() => onArchiveToggle?.(session.id));
  }, [runAndClose, onArchiveToggle, session.id]);

  const handleSubmitTag = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const v = tagDraft.trim();
      if (v) {
        onAddTag(v);
      }
      setTagDraft("");
      setAddingTag(false);
      onClose();
    },
    [tagDraft, onAddTag, onClose],
  );

  if (!position || !clampedPos) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("mobile.sessionActions")}
      className={styles.menu}
      style={{ left: clampedPos.left, top: clampedPos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button role="menuitem" onClick={handlePin} className={styles.menuItem}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.menuIcon}>
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
        <span>{isPinned ? t("session.unpin") : t("session.pin")}</span>
      </button>
      <button
        role="menuitem"
        onClick={handleParallel}
        disabled={isParallelOpen}
        className={`${styles.menuItem} ${isParallelOpen ? styles.menuItemDisabled : ""}`}
        title={isParallelOpen ? t("session.alreadyParallel") : t("session.openParallel")}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.menuIcon}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="12" y1="3" x2="12" y2="21" />
        </svg>
        <span>{t("session.openParallel")}</span>
      </button>
      <div className={styles.separator} />
      <button role="menuitem" onClick={handleRename} className={styles.menuItem}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.menuIcon}>
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
        <span>{t("session.rename")}</span>
      </button>
      {addingTag ? (
        <form onSubmit={handleSubmitTag} className={styles.tagForm} role="menuitem">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.menuIcon}>
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
            <line x1="7" y1="7" x2="7.01" y2="7" />
          </svg>
          <input
            ref={tagInputRef}
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setAddingTag(false);
                setTagDraft("");
              }
            }}
            placeholder={existingTags.length > 0 ? t("session.newTag") : t("session.addTag")}
            className={styles.tagInput}
            maxLength={32}
          />
        </form>
      ) : (
        <button
          role="menuitem"
          onClick={() => setAddingTag(true)}
          className={styles.menuItem}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.menuIcon}>
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
            <line x1="7" y1="7" x2="7.01" y2="7" />
          </svg>
          <span>{t("session.addTag")}</span>
        </button>
      )}
      {/* Current tags — click × to remove (the menu stays open for multi-remove) */}
      {onRemoveTag && existingTags.length > 0 && (
        <div className={styles.tagList} role="menuitem" aria-label={t("session.currentTags")}>
          {existingTags.map((tag) => {
            const ts = getTagStyle(tag, theme);
            return (
              <span
                key={tag}
                className={styles.tagListChip}
                style={{ background: ts.bg, color: ts.fg, borderColor: ts.border }}
              >
                #{tag}
                <button
                  onClick={() => onRemoveTag(tag)}
                  className={styles.tagListRemove}
                  title={`${t("session.removeTag")} #${tag}`}
                  aria-label={`${t("session.removeTag")} #${tag}`}
                >×</button>
              </span>
            );
          })}
        </div>
      )}
      <div className={styles.separator} />
      {onArchiveToggle && (
        <button role="menuitem" onClick={handleArchive} className={styles.menuItem}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.menuIcon}>
            <polyline points="21 8 21 21 3 21 3 8" />
            <rect x="1" y="3" width="22" height="5" />
            <line x1="10" y1="12" x2="14" y2="12" />
          </svg>
          <span>{isArchived ? t("session.unarchive") : t("session.archive")}</span>
        </button>
      )}
      <button role="menuitem" onClick={handleDelete} className={`${styles.menuItem} ${styles.menuItemDanger}`}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.menuIcon}>
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </svg>
        <span>{t("session.delete")}</span>
      </button>
    </div>
  );
}

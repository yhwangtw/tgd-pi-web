"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Archive, Columns2, Pencil, Star, Tag, Trash2 } from "lucide-react";
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
        <Star size={13} fill={isPinned ? "currentColor" : "none"} className={styles.menuIcon} aria-hidden />
        <span>{isPinned ? t("session.unpin") : t("session.pin")}</span>
      </button>
      <button
        role="menuitem"
        onClick={handleParallel}
        disabled={isParallelOpen}
        className={`${styles.menuItem} ${isParallelOpen ? styles.menuItemDisabled : ""}`}
        title={isParallelOpen ? t("session.alreadyParallel") : t("session.openParallel")}
      >
        <Columns2 size={13} className={styles.menuIcon} aria-hidden />
        <span>{t("session.openParallel")}</span>
      </button>
      <div className={styles.separator} />
      <button role="menuitem" onClick={handleRename} className={styles.menuItem}>
        <Pencil size={13} className={styles.menuIcon} aria-hidden />
        <span>{t("session.rename")}</span>
      </button>
      {addingTag ? (
        <form onSubmit={handleSubmitTag} className={styles.tagForm} role="menuitem">
          <Tag size={13} className={styles.menuIcon} aria-hidden />
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
          <Tag size={13} className={styles.menuIcon} aria-hidden />
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
          <Archive size={13} className={styles.menuIcon} aria-hidden />
          <span>{isArchived ? t("session.unarchive") : t("session.archive")}</span>
        </button>
      )}
      <button role="menuitem" onClick={handleDelete} className={`${styles.menuItem} ${styles.menuItemDanger}`}>
        <Trash2 size={13} className={styles.menuIcon} aria-hidden />
        <span>{t("session.delete")}</span>
      </button>
    </div>
  );
}

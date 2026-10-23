"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { X } from "lucide-react";

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
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
  const addTagRef = useRef<HTMLButtonElement>(null);
  const wasAddingTag = useRef(false);

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

  // Focus only after the input or its launcher has committed to the DOM.
  useEffect(() => {
    if (addingTag) tagInputRef.current?.focus();
    else if (wasAddingTag.current) addTagRef.current?.focus();
    wasAddingTag.current = addingTag;
  }, [addingTag]);

  // Clamp the menu to the viewport so it never opens off-screen
  const [clampedPos, setClampedPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!position) {
      setClampedPos(null);
      return;
    }
    const clamp = () => {
      const menu = menuRef.current;
      if (!menu) return;
      const padding = 8;
      setClampedPos({
        left: Math.max(padding, Math.min(position.x, window.innerWidth - menu.offsetWidth - padding)),
        top: Math.max(padding, Math.min(position.y, window.innerHeight - menu.offsetHeight - padding)),
      });
    };
    clamp();
    window.addEventListener("resize", clamp);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(clamp);
    if (menuRef.current) observer?.observe(menuRef.current);
    return () => { window.removeEventListener("resize", clamp); observer?.disconnect(); };
  }, [position, addingTag, existingTags.length]);

  useEffect(() => {
    if (position) menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
  }, [position]);

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

  if (!position) return null;

  // Virtualized rows have transformed ancestors: portal the menu so it cannot
  // be clipped or positioned relative to a scrolling row.
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("mobile.sessionActions")}
      className={styles.menu}
      style={{ left: clampedPos?.left ?? position.x, top: clampedPos?.top ?? position.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
        if (e.key === "Tab") { onClose(); return; }
        if ((e.target as HTMLElement).tagName === "INPUT" && !["ArrowDown", "ArrowUp"].includes(e.key)) return;
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('button[role="menuitem"], input[data-menu-focus]') ?? []);
        const enabled = items.filter(item => !item.matches(":disabled"));
        const current = enabled.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? enabled.length - 1
          : (current + (e.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
        enabled[next]?.focus();
      }}
    >
      <button role="menuitem" onClick={handlePin} className={styles.menuItem}>
        <Star size={UI_ICON_SIZE.compact} fill={isPinned ? "currentColor" : "none"} className={styles.menuIcon} aria-hidden />
        <span>{isPinned ? t("session.unpin") : t("session.pin")}</span>
      </button>
      <button
        role="menuitem"
        onClick={handleParallel}
        disabled={isParallelOpen}
        className={`${styles.menuItem} ${isParallelOpen ? styles.menuItemDisabled : ""}`}
        title={isParallelOpen ? t("session.alreadyParallel") : t("session.openParallel")}
      >
        <Columns2 size={UI_ICON_SIZE.compact} className={styles.menuIcon} aria-hidden />
        <span>{t("session.openParallel")}</span>
      </button>
      <div className={styles.separator} />
      <button role="menuitem" onClick={handleRename} className={styles.menuItem}>
        <Pencil size={UI_ICON_SIZE.compact} className={styles.menuIcon} aria-hidden />
        <span>{t("session.rename")}</span>
      </button>
      {addingTag ? (
        <form onSubmit={handleSubmitTag} className={styles.tagForm} role="group" aria-label={t("session.addTag")}>
          <Tag size={UI_ICON_SIZE.compact} className={styles.menuIcon} aria-hidden />
          <input
            ref={tagInputRef}
            data-menu-focus
            aria-label={t("session.addTag")}
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
          ref={addTagRef}
          role="menuitem"
          onClick={() => setAddingTag(true)}
          className={styles.menuItem}
        >
          <Tag size={UI_ICON_SIZE.compact} className={styles.menuIcon} aria-hidden />
          <span>{t("session.addTag")}</span>
        </button>
      )}
      {/* Current tags — click × to remove (the menu stays open for multi-remove) */}
      {onRemoveTag && existingTags.length > 0 && (
        <div className={styles.tagList} role="group" aria-label={t("session.currentTags")}>
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
                  type="button"
                  role="menuitem"
                  onClick={() => onRemoveTag(tag)}
                  className={styles.tagListRemove}
                  title={`${t("session.removeTag")} #${tag}`}
                  aria-label={`${t("session.removeTag")} #${tag}`}
                ><X size={UI_ICON_SIZE.compact} aria-hidden="true" /></button>
              </span>
            );
          })}
        </div>
      )}
      <div className={styles.separator} />
      {onArchiveToggle && (
        <button role="menuitem" onClick={handleArchive} className={styles.menuItem}>
          <Archive size={UI_ICON_SIZE.compact} className={styles.menuIcon} aria-hidden />
          <span>{isArchived ? t("session.unarchive") : t("session.archive")}</span>
        </button>
      )}
      <button role="menuitem" onClick={handleDelete} className={`${styles.menuItem} ${styles.menuItemDanger}`}>
        <Trash2 size={UI_ICON_SIZE.compact} className={styles.menuIcon} aria-hidden />
        <span>{t("session.delete")}</span>
      </button>
    </div>, document.body,
  );
}

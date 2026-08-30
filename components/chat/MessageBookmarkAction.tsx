"use client";

import { useI18n } from "@/lib/i18n";
import { Star } from "lucide-react";
import styles from "./MessageBookmarkAction.module.css";

function BookmarkIcon({ filled, size }: { filled: boolean; size: number }) {
  return <Star size={size} fill={filled ? "currentColor" : "none"} strokeWidth={1.9} aria-hidden />;
}

export function MessageBookmarkAction({
  isBookmarked,
  onToggle,
  className,
}: {
  isBookmarked: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  const title = isBookmarked ? t("chat.unbookmark") : t("chat.bookmark");

  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-label={title}
      aria-pressed={isBookmarked}
      data-bookmark-action
      className={`${className ?? ""} ${styles.action} ${isBookmarked ? styles.actionActive : ""}`}
    >
      <BookmarkIcon filled={isBookmarked} size={13} />
      <span>{isBookmarked ? t("chat.removeBookmarkAction") : t("chat.bookmarkAction")}</span>
    </button>
  );
}

export function MessageBookmarkIndicator({ isBookmarked }: { isBookmarked: boolean }) {
  const { t } = useI18n();
  if (!isBookmarked) return null;

  return (
    <span
      className={styles.indicator}
      title={t("chat.bookmarked")}
      aria-label={t("chat.bookmarked")}
      data-bookmark-indicator
    >
      <BookmarkIcon filled size={11} />
    </span>
  );
}

"use client";

import type { SessionTags } from "@/hooks/useTags";
import { getTagStyle } from "@/lib/tag-colors";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";
import { X } from "lucide-react";
import styles from "./TagFilter.module.css";

interface Props {
  tags: SessionTags;
  activeTag: string | null;
  onSelectTag: (tag: string | null) => void;
}

export function TagFilter({ tags, activeTag, onSelectTag }: Props) {
  const { theme } = useTheme();
  const { t } = useI18n();
  const all = Object.entries(tags)
    .map(([tag, sessions]) => ({ tag, count: sessions.length }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 20);

  if (all.length === 0) return null;

  return (
    <div className={styles.row}>
      {all.map(({ tag, count }) => {
        const ts = getTagStyle(tag, theme);
        const isActive = activeTag === tag;
        // Active state keeps the same hue but uses a stronger fill so it reads
        // as "selected". ts.fg is dark in light mode / pastel in dark mode, so
        // the text sitting on top of it flips with the theme.
        const activeText = "var(--tag-active-text)";
        const bg = isActive ? ts.fg : ts.bg;
        const fg = isActive ? activeText : ts.fg;
        const border = isActive ? ts.fg : ts.border;
        return (
          <button
            key={tag}
            onClick={() => onSelectTag(activeTag === tag ? null : tag)}
            className={styles.chip}
            title={t("tags.sessionCount").replace("{count}", String(count)).replace("{tag}", tag)}
            style={{ background: bg, color: fg, borderColor: border }}
          >
            #{tag}
            <span
              className={styles.count}
              // Badge stays in the tag's own hue: the stronger border tint
              // doubles as its fill (gray --bg-elev-2 looked foreign next to
              // the identical chips on the session rows).
              style={isActive
                ? { background: "var(--tag-active-count-bg)", color: activeText }
                : { background: ts.border, color: ts.fg }}
            >
              {count}
            </span>
          </button>
        );
      })}
      {activeTag && (
        <button type="button" onClick={() => onSelectTag(null)} className={styles.clear} title={t("tags.clearFilter")} aria-label={t("tags.clearFilter")}>
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { ChevronDown, ListCollapse } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { MarkdownBody } from "./MarkdownBody";
import styles from "./CompactionSummary.module.css";

export { getCompactionSummary } from "@/lib/compaction-message";

export function CompactionSummary({ summary }: { summary: string }) {
  const { t } = useI18n();
  return (
    <details className={styles.card}>
      <summary className={styles.header}>
        <span className={styles.icon} aria-hidden>
          <ListCollapse size={UI_ICON_SIZE.compact} />
        </span>
        <span className={styles.title}>{t("chat.compactionSummary")}</span>
        <span className={styles.hint}>{t("chat.compactionSummaryHint")}</span>
        <ChevronDown className={styles.chevron} size={UI_ICON_SIZE.inline} aria-hidden />
      </summary>
      <div className={styles.body}><MarkdownBody>{summary}</MarkdownBody></div>
    </details>
  );
}

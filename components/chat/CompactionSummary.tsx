"use client";

import type { AgentMessage } from "@/lib/types";
import { ChevronDown, ListCollapse } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { MarkdownBody } from "./MarkdownBody";
import styles from "./CompactionSummary.module.css";

const COMPACTION_PREFIX = "*The conversation history before this point was compacted into the following summary:*";

export function getCompactionSummary(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || !content.startsWith(COMPACTION_PREFIX)) return null;
  return content.slice(COMPACTION_PREFIX.length).trim();
}

export function CompactionSummary({ summary }: { summary: string }) {
  const { t } = useI18n();
  return (
    <details className={styles.card}>
      <summary className={styles.header}>
        <span className={styles.icon} aria-hidden>
          <ListCollapse size={14} strokeWidth={1.8} />
        </span>
        <span className={styles.title}>{t("chat.compactionSummary")}</span>
        <span className={styles.hint}>{t("chat.compactionSummaryHint")}</span>
        <ChevronDown className={styles.chevron} size={12} strokeWidth={1.6} aria-hidden />
      </summary>
      <div className={styles.body}><MarkdownBody>{summary}</MarkdownBody></div>
    </details>
  );
}

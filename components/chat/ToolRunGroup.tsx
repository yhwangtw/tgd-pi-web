"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronDown, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ToolCallContent, ToolResultMessage } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import styles from "./ToolRunGroup.module.css";

export interface ToolRunItem {
  block: ToolCallContent;
  result?: ToolResultMessage;
  duration?: number;
}

interface Props {
  items: ToolRunItem[];
  activeToolCallId?: string;
  children: ReactNode;
}

export function ToolRunGroup({ items, activeToolCallId, children }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  const active = items.find((item) => item.block.toolCallId === activeToolCallId);
  const failedCount = items.filter((item) => item.result?.isError).length;
  // Result timestamps are measured from the same assistant-message boundary,
  // so max is the elapsed run time; summing would over-count parallel calls.
  const elapsed = Math.max(0, ...items.map((item) => item.duration ?? 0));

  return (
    <section className={`${styles.group} ${active ? styles.groupRunning : ""} ${failedCount ? styles.groupError : ""}`}>
      <button
        type="button"
        className={styles.summary}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className={styles.stateIcon} aria-hidden>
          {active ? (
            <LoaderCircle className={styles.spinner} size={13} strokeWidth={2.4} />
          ) : failedCount ? (
            <TriangleAlert size={13} strokeWidth={2.2} />
          ) : (
            <Check size={13} strokeWidth={2.2} />
          )}
        </span>
        <span className={styles.label} aria-live={active ? "polite" : undefined}>
          {active ? (
            <>{t("chat.runningTool")} <strong>{active.block.toolName}</strong></>
          ) : (
            <>{t("chat.ranTools")} <strong>{items.length}</strong> {t("chat.tools")}</>
          )}
        </span>
        <span className={styles.meta}>
          {failedCount > 0 && <span className={styles.failed}>{failedCount} {t("chat.failed")}</span>}
          {elapsed > 0 && <span>{elapsed}s</span>}
        </span>
        <ChevronDown className={styles.chevron} size={11} strokeWidth={1.6} aria-hidden />
      </button>
      {expanded && <div className={styles.children}>{children}</div>}
    </section>
  );
}

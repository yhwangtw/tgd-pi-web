"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { type ReactNode } from "react";
import { Check, ChevronDown, Clock3, CircleMinus, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ToolCallContent, ToolResultMessage } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { toolExecutionState, toolGroupState, toolStateLabel, type ToolExecutionContext } from "@/lib/tool-execution-state";
import { useRequestedDisclosure } from "./use-requested-disclosure";
import styles from "./ToolRunGroup.module.css";

export interface ToolRunItem {
  block: ToolCallContent;
  result?: ToolResultMessage;
  duration?: number;
}

interface Props {
  items: ToolRunItem[];
  executionContext?: ToolExecutionContext;
  children: ReactNode;
}

export function ToolRunGroup({ items, executionContext, children }: Props) {
  const request = executionContext?.revealRequest;
  const [expanded, setExpanded] = useRequestedDisclosure(items.some(item => item.block.toolCallId === request?.id) ? request?.nonce : undefined);
  const { t } = useI18n();
  const states = items.map(item => toolExecutionState(item.block.toolCallId, item.result, executionContext));
  const state = toolGroupState(states);
  const active = state === "running" || state === "preparing";
  const activeCount = states.filter(value => value === "running").length;
  const pendingCount = states.filter(value => value === "pending" || value === "preparing").length;
  const failedCount = items.filter((item) => item.result?.isError).length;
  // Result timestamps are measured from the same assistant-message boundary,
  // so max is the elapsed run time; summing would over-count parallel calls.
  const elapsed = Math.max(0, ...items.map((item) => item.duration ?? 0));

  return (
    <section data-tool-group-state={state} className={`${styles.group} ${active ? styles.groupRunning : state === "error" ? styles.groupError : state === "success" ? styles.groupSuccess : ""}`}>
      <button
        type="button"
        className={styles.summary}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className={styles.stateIcon} aria-hidden>
          {active ? (
            <LoaderCircle className={styles.spinner} size={UI_ICON_SIZE.compact} />
          ) : state === "error" ? (
            <TriangleAlert size={UI_ICON_SIZE.compact} />
          ) : state === "success" ? (
            <Check size={UI_ICON_SIZE.compact} />
          ) : state === "cancelled" ? <CircleMinus size={UI_ICON_SIZE.compact} /> : <Clock3 size={UI_ICON_SIZE.compact} />}
        </span>
        <span className={styles.label} aria-live={active ? "polite" : undefined}>
          {state === "success" ? t("chat.ranTools") : t(toolStateLabel[state])} <strong>{items.length}</strong> {t("chat.tools")}
        </span>
        <span className={styles.meta}>
          {activeCount > 0 && <span>{activeCount} {t("chat.runningTool")}</span>}
          {pendingCount > 0 && <span>{pendingCount} {t("chat.toolPending")}</span>}
          {failedCount > 0 && <span className={styles.failed}>{failedCount} {t("chat.failed")}</span>}
          {elapsed > 0 && <span>{elapsed}s</span>}
        </span>
        <ChevronDown className={styles.chevron} size={UI_ICON_SIZE.inline} aria-hidden />
      </button>
      {expanded && <div className={styles.children}>{children}</div>}
    </section>
  );
}

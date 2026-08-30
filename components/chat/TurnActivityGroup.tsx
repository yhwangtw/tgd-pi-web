"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, TriangleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import styles from "./TurnActivityGroup.module.css";

interface Props {
  steps: number;
  tools: number;
  filesChanged: number;
  failed: number;
  elapsed?: number;
  children: ReactNode;
}

export function TurnActivityGroup({ steps, tools, filesChanged, failed, elapsed, children }: Props) {
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const pendingScrollRef = useRef<{
    container: HTMLElement;
    scrollTop: number;
    overflowAnchor: string;
  } | null>(null);
  const { t } = useI18n();
  const statusText = failed > 0
    ? `${t("chat.workNeedsAttention")} · ${failed}`
    : t("chat.workComplete");
  const stepLabel = t(steps === 1 ? "chat.step" : "chat.steps");
  const toolLabel = t(tools === 1 ? "chat.tool" : "chat.tools");
  const fileLabel = t(filesChanged === 1 ? "chat.fileChanged" : "chat.filesChanged");
  const summaryLabel = [
    t("chat.workLog"),
    statusText,
    `${steps} ${stepLabel}`,
    tools > 0 ? `${tools} ${toolLabel}` : null,
    filesChanged > 0 ? `${filesChanged} ${fileLabel}` : null,
    elapsed !== undefined && elapsed > 0 ? `${elapsed}s` : null,
  ].filter(Boolean).join(" · ");

  const toggleExpanded = () => {
    const container = rootRef.current?.closest<HTMLElement>("[data-transcript-scroll]");
    if (container) {
      pendingScrollRef.current = {
        container,
        scrollTop: container.scrollTop,
        overflowAnchor: container.style.overflowAnchor,
      };
      // Browser scroll anchoring otherwise follows content below a long work
      // log and moves the clicked summary as the disclosure opens.
      container.style.overflowAnchor = "none";
    }
    setExpanded((value) => !value);
  };

  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    pending.container.scrollTop = pending.scrollTop;
    const restore = () => {
      // Re-apply after layout/scroll anchoring has settled but before paint.
      // This also covers large disclosures whose content-visibility state
      // changes in the same render.
      pending.container.scrollTop = pending.scrollTop;
      pending.container.style.overflowAnchor = pending.overflowAnchor;
      pendingScrollRef.current = null;
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
    else restore();
  }, [expanded]);

  return (
    <section
      ref={rootRef}
      className={`${styles.root} ${failed ? styles.rootError : ""}`}
      aria-label={t("chat.workLog")}
      data-work-log-expanded={expanded ? "true" : "false"}
    >
      <button
        type="button"
        className={styles.summary}
        onClick={toggleExpanded}
        aria-expanded={expanded}
        aria-label={summaryLabel}
      >
        <span className={styles.stateIcon} aria-hidden>
          {failed ? (
            <TriangleAlert size={13} strokeWidth={2.2} />
          ) : (
            <Check size={13} strokeWidth={2.2} />
          )}
        </span>
        <span className={styles.title}>{t("chat.workLog")}</span>
        {failed > 0 && (
          <span className={`${styles.outcome} ${styles.outcomeError}`}>
            {statusText}
          </span>
        )}
        <span className={styles.meta}>
          {tools > 0 ? <span>{tools} {toolLabel}</span> : <span>{steps} {stepLabel}</span>}
          {filesChanged > 0 && <span>{filesChanged} {fileLabel}</span>}
          {elapsed !== undefined && elapsed > 0 && <span>{elapsed}s</span>}
        </span>
        <ChevronDown className={styles.chevron} size={11} strokeWidth={1.6} aria-hidden />
      </button>
      {expanded && <div className={styles.body}>{children}</div>}
    </section>
  );
}

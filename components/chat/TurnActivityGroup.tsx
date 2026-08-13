"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
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
        <svg className={styles.chevron} width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>
      {expanded && <div className={styles.body}>{children}</div>}
    </section>
  );
}

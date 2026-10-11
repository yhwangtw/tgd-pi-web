"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { motionScrollBehavior } from "@/lib/motion";
import styles from "./PlainSourceView.module.css";

const PAGE_SIZE = 500;
interface Props {
  content: string;
  activeLine?: number | null;
  diagnosticLines?: Record<number, "error" | "warning">;
  wrapLines?: boolean;
}

/** Bounded DOM, while the parent still searches the entire loaded file. */
export function PlainSourceView({ content, activeLine, diagnosticLines = {}, wrapLines = false }: Props) {
  const { t } = useI18n();
  const lines = useMemo(() => content.split("\n"), [content]);
  const [page, setPage] = useState(() => Math.floor(Math.max(0, (activeLine ?? 1) - 1) / PAGE_SIZE));
  const rootRef = useRef<HTMLDivElement>(null);
  const pageCount = Math.ceil(lines.length / PAGE_SIZE);
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * PAGE_SIZE;
  const end = Math.min(lines.length, start + PAGE_SIZE);
  useEffect(() => {
    if (activeLine == null || activeLine < 1 || activeLine > lines.length) return;
    setPage(Math.floor((activeLine - 1) / PAGE_SIZE));
    const timer = setTimeout(() => rootRef.current?.querySelector("[data-active-line]")?.scrollIntoView({ block: "center", behavior: motionScrollBehavior() }), 50);
    return () => clearTimeout(timer);
  }, [activeLine, lines.length]);

  return <div ref={rootRef}>
    {pageCount > 1 && <nav className={styles.pagination} aria-label={t("files.pageRange")}>
      <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("files.pagePrevious")}</button>
      <span role="status">{t("files.pageRange")} {start + 1}–{end} / {lines.length}</span>
      <button type="button" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>{t("files.pageNext")}</button>
    </nav>}
    <pre className={styles.plainPre} style={{ whiteSpace: wrapLines ? "pre-wrap" : "pre" }}>
      {lines.slice(start, end).map((line, index) => {
        const number = start + index + 1;
        const active = number === activeLine;
        return <div key={number} className={active ? styles.lineActive : styles.line}
          data-active-line={active ? "1" : undefined} data-line-number={number} data-diagnostic={diagnosticLines[number]}
          style={{ whiteSpace: wrapLines ? "pre-wrap" : "pre", ...(diagnosticLines[number] ? { boxShadow: `inset 2px 0 var(--color-${diagnosticLines[number]})` } : {}) }}>
          <span className={styles.lineNo}>{number}</span>{line || " "}
        </div>;
      })}
    </pre>
  </div>;
}

"use client";

import { Fragment, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { diffLines, type DiffLine } from "@/lib/line-diff";
import styles from "./DiffView.module.css";

export interface DiffAnnotation {
  lineNo: number;
  type: DiffLine["type"];
  text: string;
  comment: string;
}


export function DiffView({
  oldContent,
  newContent,
  language: _language,
  onAnnotate,
}: {
  oldContent: string;
  newContent: string;
  language: string;
  onAnnotate?: (annotation: DiffAnnotation) => void;
}) {
  const { t } = useI18n();
  const [annotationLine, setAnnotationLine] = useState<number | null>(null);
  const [annotationText, setAnnotationText] = useState("");
  const diff = useMemo(() => diffLines(
    oldContent === "" ? [] : oldContent.split("\n"),
    newContent === "" ? [] : newContent.split("\n"),
  ), [oldContent, newContent]);

  const hasChanges = diff.some((l) => l.type !== "unchanged");
  if (!hasChanges) {
    return (
      <div className={styles.noChanges}>
        {t("files.diff.noChanges")}
      </div>
    );
  }

  // Render with context: show 3 lines around each change, collapse the rest
  const CONTEXT = 3;
  const changed = new Set(diff.flatMap((l, i) => (l.type !== "unchanged" ? [i] : [])));
  const visible = new Set<number>();
  for (const ci of changed) {
    for (let j = Math.max(0, ci - CONTEXT); j <= Math.min(diff.length - 1, ci + CONTEXT); j++) {
      visible.add(j);
    }
  }

  const segments: Array<{ hidden: true; count: number } | { hidden: false; lines: DiffLine[] }> = [];
  let i = 0;
  while (i < diff.length) {
    if (visible.has(i)) {
      const block: DiffLine[] = [];
      while (i < diff.length && visible.has(i)) {
        block.push(diff[i]);
        i++;
      }
      segments.push({ hidden: false, lines: block });
    } else {
      let count = 0;
      while (i < diff.length && !visible.has(i)) {
        count++;
        i++;
      }
      segments.push({ hidden: true, count });
    }
  }

  // Track running line number for added/unchanged lines
  const newLineNos: number[] = [];
  let nlo = 1;
  for (const line of diff) {
    if (line.type === "removed") {
      newLineNos.push(0);
    } else {
      newLineNos.push(nlo++);
    }
  }

  let diffIdx = 0;

  return (
    <div className={styles.root}>
      {segments.map((seg, si) => {
        if (seg.hidden) {
          const result = (
            <div
              key={si}
              className={styles.hiddenSegment}
            >
              {t("files.diff.unchangedLines").replace("{count}", String(seg.count))}
            </div>
          );
          diffIdx += seg.count;
          return result;
        }
        const lines = seg.lines.map((line, li) => {
          const idx = diffIdx + li;
          const newLno = newLineNos[idx];
          const lineClass = [
            styles.diffLine,
            line.type === "added" ? styles.diffLineAdded
              : line.type === "removed" ? styles.diffLineRemoved
              : styles.diffLineUnchanged,
          ].join(" ");
          const prefixClass = [
            styles.prefix,
            line.type === "added" ? styles.prefixAdded
              : line.type === "removed" ? styles.prefixRemoved
              : styles.prefixUnchanged,
          ].join(" ");
          const prefix =
            line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";

          const lineNumber = line.type === "removed" ? line.lineNo : newLno || line.lineNo;
          const isAnnotating = annotationLine === idx;
          return (
            <Fragment key={li}>
              <div className={lineClass} data-diff-line={lineNumber}
                data-diff-new-line={line.type === "removed" ? undefined : newLno}
                data-diff-old-line={line.type === "added" ? undefined : line.lineNo}>
                <span className={styles.lineNumber}>{line.type === "removed" ? line.lineNo : newLno || ""}</span>
                <span className={prefixClass}>{prefix}</span>
                <span className={styles.lineText}>{line.text || "\u00a0"}</span>
                {onAnnotate && (
                  <button
                    type="button"
                    className={styles.lineAction}
                    aria-label={`${t("diff.annotateLine")} ${lineNumber}`}
                    title={t("diff.annotateLine")}
                    onClick={() => {
                      setAnnotationLine((current) => current === idx ? null : idx);
                      setAnnotationText("");
                    }}
                  >
                    +
                  </button>
                )}
              </div>
              {isAnnotating && onAnnotate && (
                <div className={styles.annotationEditor} data-testid="diff-annotation-editor">
                  <textarea
                    autoFocus
                    value={annotationText}
                    onChange={(event) => setAnnotationText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") { event.preventDefault(); setAnnotationLine(null); }
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        const comment = annotationText.trim();
                        if (!comment) return;
                        onAnnotate({ lineNo: lineNumber, type: line.type, text: line.text, comment });
                        setAnnotationLine(null);
                        setAnnotationText("");
                      }
                    }}
                    placeholder={t("diff.commentPlaceholder")}
                    rows={2}
                  />
                  <div className={styles.annotationActions}>
                    <span>{t("diff.commentShortcut")}</span>
                    <button
                      type="button"
                      disabled={!annotationText.trim()}
                      onClick={() => {
                        const comment = annotationText.trim();
                        if (!comment) return;
                        onAnnotate({ lineNo: lineNumber, type: line.type, text: line.text, comment });
                        setAnnotationLine(null);
                        setAnnotationText("");
                      }}
                    >{t("diff.addToPrompt")}</button>
                  </div>
                </div>
              )}
            </Fragment>
          );
        });
        diffIdx += seg.lines.length;
        return <div key={si}>{lines}</div>;
      })}
    </div>
  );
}

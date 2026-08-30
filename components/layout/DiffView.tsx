"use client";

import { Fragment, useState } from "react";
import { useI18n } from "@/lib/i18n";
import styles from "./DiffView.module.css";

type DiffLine =
  | { type: "unchanged"; text: string; lineNo: number }
  | { type: "removed"; text: string; lineNo: number }
  | { type: "added"; text: string; lineNo: number };

export interface DiffAnnotation {
  lineNo: number;
  type: DiffLine["type"];
  text: string;
  comment: string;
}

function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const max = m + n;
  const v: number[] = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  for (let d = 0; d <= max; d++) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max];
      } else {
        x = v[k - 1 + max] + 1;
      }
      let y = x - k;
      while (x < m && y < n && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      v[k + max] = x;
      if (x >= m && y >= n) {
        // backtrack
        const result: DiffLine[] = [];
        let cx = m, cy = n;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd - 1];
          const pk = cx - cy;
          let prevK: number;
          if (pk === -dd || (pk !== dd && pv[pk - 1 + max] < pv[pk + 1 + max])) {
            prevK = pk + 1;
          } else {
            prevK = pk - 1;
          }
          const prevX = pv[prevK + max];
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            cx--;
            cy--;
            result.unshift({ type: "unchanged", text: oldLines[cx], lineNo: cx + 1 });
          }
          if (dd > 0) {
            if (cx > prevX) {
              cx--;
              result.unshift({ type: "removed", text: oldLines[cx], lineNo: cx + 1 });
            } else {
              cy--;
              result.unshift({ type: "added", text: newLines[cy], lineNo: cy + 1 });
            }
          }
        }
        while (cx > 0 && cy > 0) {
          cx--;
          cy--;
          result.unshift({ type: "unchanged", text: oldLines[cx], lineNo: cx + 1 });
        }
        return result;
      }
    }
  }
  // Fallback: treat all as replaced
  return [
    ...oldLines.map((t, i) => ({ type: "removed" as const, text: t, lineNo: i + 1 })),
    ...newLines.map((t, i) => ({ type: "added" as const, text: t, lineNo: i + 1 })),
  ];
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
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diff = diffLines(oldLines, newLines);

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
              <div className={lineClass} data-diff-line={lineNumber}>
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

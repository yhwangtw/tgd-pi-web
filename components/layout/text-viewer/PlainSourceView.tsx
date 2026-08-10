"use client";

import { useEffect, useMemo } from "react";
import styles from "./PlainSourceView.module.css";

const CHUNK = 500;

interface Props {
  content: string;
  /** 1-based line to highlight + scroll to. */
  activeLine?: number | null;
  diagnosticLines?: Record<number, "error" | "warning">;
}

/**
 * Cheap renderer for large files: no syntax highlighting, lines grouped into
 * content-visibility chunks so offscreen content costs nothing to paint.
 * Keeps per-line elements, so in-file find / go-to-line still works exactly.
 */
export function PlainSourceView({ content, activeLine, diagnosticLines = {} }: Props) {
  const chunks = useMemo(() => {
    const lines = content.split("\n");
    const out: string[][] = [];
    for (let i = 0; i < lines.length; i += CHUNK) {
      out.push(lines.slice(i, i + CHUNK));
    }
    return out;
  }, [content]);

  useEffect(() => {
    if (activeLine == null) return;
    const t = setTimeout(() => {
      document.querySelector("[data-active-line]")?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
    return () => clearTimeout(t);
  }, [activeLine, content]);

  return (
    <pre className={styles.plainPre}>
      {chunks.map((chunk, ci) => (
        <div key={ci} className={styles.chunk}>
          {chunk.map((line, li) => {
            const n = ci * CHUNK + li + 1;
            const active = n === activeLine;
            return (
              <div
                key={n}
                className={active ? styles.lineActive : styles.line}
                data-active-line={active ? "1" : undefined}
                data-line-number={n}
                data-diagnostic={diagnosticLines[n]}
                style={diagnosticLines[n] ? { borderLeft: `3px solid var(--color-${diagnosticLines[n]})` } : undefined}
              >
                <span className={styles.lineNo}>{n}</span>
                {line.length > 0 ? line : " "}
              </div>
            );
          })}
        </div>
      ))}
    </pre>
  );
}

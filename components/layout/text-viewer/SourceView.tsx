"use client";

import { PrismAsync as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme } from "@/hooks/useTheme";

import { useEffect, memo } from "react";

interface Props {
  content: string;
  language: string;
  wrapLines: boolean;
  /** 1-based line to highlight + scroll to (in-file find / go-to-line). */
  activeLine?: number | null;
  diagnosticLines?: Record<number, "error" | "warning">;
}

// Memoized: highlighting a big file is the most expensive render in the app,
// and the parent re-renders on every toolbar keystroke.
export const SourceView = memo(function SourceView({ content, language, wrapLines, activeLine, diagnosticLines = {} }: Props) {
  const { isDark } = useTheme();

  useEffect(() => {
    if (activeLine == null) return;
    // After the highlighter re-renders with the marked line, center it.
    const t = setTimeout(() => {
      document.querySelector("[data-active-line]")?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
    return () => clearTimeout(t);
  }, [activeLine, content]);

  return (
    <SyntaxHighlighter
      language={language === "text" ? "plaintext" : language}
      style={isDark ? vscDarkPlus : vs}
      showLineNumbers
      lineNumberStyle={LINE_NUMBER_STYLE}
      customStyle={CUSTOM_STYLE}
      codeTagProps={CODE_TAG_STYLE}
      wrapLongLines={wrapLines}
      // Per-line nodes support selection-aware Agent actions, outline jumps,
      // diagnostics, and durable line annotations.
      wrapLines
      lineProps={(n: number) =>
        n === activeLine
          ? { style: { display: "block", background: "var(--color-accent-bg-strong)", borderLeft: diagnosticLines[n] ? `3px solid var(--color-${diagnosticLines[n]})` : undefined }, "data-active-line": "1", "data-line-number": String(n), "data-diagnostic": diagnosticLines[n] } as React.HTMLProps<HTMLElement>
          : { style: { display: "block", borderLeft: diagnosticLines[n] ? `3px solid var(--color-${diagnosticLines[n]})` : undefined }, "data-line-number": String(n), "data-diagnostic": diagnosticLines[n] } as React.HTMLProps<HTMLElement>
      }
    >
      {content}
    </SyntaxHighlighter>
  );
});

const LINE_NUMBER_STYLE: React.CSSProperties = {
  color: "var(--text-dim)",
  fontStyle: "normal",
  minWidth: "3em",
  paddingRight: "1em",
};

const CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: "12px 0",
  background: "var(--bg)",
  fontSize: "var(--text-md)",
  lineHeight: "var(--leading-relaxed)",
  fontFamily: "var(--font-mono)",
  minHeight: "100%",
};

const CODE_TAG_STYLE = { style: { fontFamily: "var(--font-mono)" } };

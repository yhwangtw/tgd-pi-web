"use client";

import type { KeyboardEvent, RefObject } from "react";
import type { PaletteResult } from "@/hooks/useCommandPalette";
import type { ContentHit, FileHit, SessionHit } from "@/hooks/useUnifiedSearchResults";
import { getFileName } from "@/lib/file-paths";
import { useI18n } from "@/lib/i18n";
import styles from "./SearchPanel.module.css";
import type { SemanticHit } from "@/lib/semantic-search";

interface Props {
  query: string;
  loading: boolean;
  visibleResultCount: number;
  showSessions: boolean;
  showFiles: boolean;
  showContent: boolean;
  showCommands: boolean;
  showSemantic: boolean;
  sessionHits: SessionHit[];
  fileHits: FileHit[];
  contentHits: ContentHit[];
  semanticHits: SemanticHit[];
  tagResults: PaletteResult[];
  commandResults: PaletteResult[];
  inputRef: RefObject<HTMLInputElement | null>;
  onPaletteResult: (result: PaletteResult) => void;
  onSelectSession: (sessionId: string) => void;
  onOpenFile: (filePath: string, fileName: string, line?: number) => void;
}

function basename(filePath: string): string {
  return filePath.split("/").filter(Boolean).pop() ?? filePath;
}

function highlight(text: string, query: string, col?: number) {
  if (!query) return text;
  const start = col == null
    ? text.toLowerCase().indexOf(query.toLowerCase())
    : Math.max(0, col - 1);
  if (start < 0 || start >= text.length) return text;
  return (
    <>
      {text.slice(0, start)}
      <mark className={styles.mark}>{text.slice(start, start + query.length)}</mark>
      {text.slice(start + query.length)}
    </>
  );
}

function handleResultKeyDown(event: KeyboardEvent<HTMLButtonElement>, input: HTMLInputElement | null) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const results = Array.from(
    event.currentTarget.closest("[data-unified-results]")?.querySelectorAll<HTMLButtonElement>("[data-search-result]") ?? [],
  );
  const index = results.indexOf(event.currentTarget);
  if (event.key === "ArrowDown") results[Math.min(index + 1, results.length - 1)]?.focus();
  else if (index <= 0) input?.focus();
  else results[index - 1]?.focus();
}

export function UnifiedSearchResults(props: Props) {
  const { t } = useI18n();
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => handleResultKeyDown(event, props.inputRef.current);

  return (
    <div className={styles.results} data-unified-results>
      {props.showSemantic && props.semanticHits.length > 0 && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>{t("search.scope.semantic")}</div>
          {props.semanticHits.map((hit) => (
            <button key={hit.id} data-search-result className={styles.result} onClick={() => hit.sessionId ? props.onSelectSession(hit.sessionId) : hit.path ? props.onOpenFile(hit.path, getFileName(hit.path), hit.line) : undefined} onKeyDown={keyDown}>
              <span className={styles.resultIcon}>{hit.source === "session" ? "◌" : hit.source === "artifact" ? "◇" : "□"}</span>
              <span className={styles.resultBody}>
                <span className={styles.resultTitle}>{hit.title}</span>
                <span className={styles.resultMeta}>{hit.source} · {Math.round(hit.score * 10) / 10}</span>
                <span className={styles.snippet}>{hit.snippet}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {props.showSessions && (props.sessionHits.length > 0 || props.tagResults.length > 0) && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>{t("search.scope.sessions")}</div>
          {props.tagResults.map((result) => (
            <button key={result.id} data-search-result className={styles.result} onClick={() => props.onPaletteResult(result)} onKeyDown={keyDown}>
              <span className={styles.resultIcon}>#</span>
              <span className={styles.resultBody}>
                <span className={styles.resultTitle}>{result.title}</span>
                <span className={styles.resultMeta}>{result.subtitle}</span>
              </span>
            </button>
          ))}
          {props.sessionHits.slice(0, 30).map((hit) => (
            <button key={hit.id} data-search-result className={styles.result} onClick={() => props.onSelectSession(hit.id)} onKeyDown={keyDown}>
              <span className={styles.resultIcon}>◌</span>
              <span className={styles.resultBody}>
                <span className={styles.resultTitle}>{hit.name || hit.firstMessage || hit.id.slice(0, 8)}</span>
                <span className={styles.resultMeta}>{basename(hit.cwd)} · {hit.messageCount} msg</span>
                {hit.matches[0]?.text && <span className={styles.snippet}>{highlight(hit.matches[0].text, props.query)}</span>}
              </span>
            </button>
          ))}
        </div>
      )}

      {props.showFiles && props.fileHits.length > 0 && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>{t("search.scope.files")}</div>
          {props.fileHits.slice(0, 50).map((hit) => (
            <button
              key={hit.full}
              data-search-result
              className={styles.result}
              onClick={() => props.onOpenFile(hit.full, hit.name)}
              onKeyDown={keyDown}
            >
              <span className={styles.resultIcon}>□</span>
              <span className={styles.resultBody}>
                <span className={styles.resultTitle}>{hit.name}</span>
                <span className={styles.resultMeta}>{hit.relative}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {props.showContent && props.contentHits.length > 0 && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>{t("search.scope.content")}</div>
          {props.contentHits.slice(0, 80).map((hit, index) => (
            <button key={`${hit.full}:${hit.line}:${hit.col}:${index}`} data-search-result className={styles.result} onClick={() => props.onOpenFile(hit.full, getFileName(hit.full), hit.line)} onKeyDown={keyDown}>
              <span className={styles.lineNumber}>{hit.line}</span>
              <span className={styles.resultBody}>
                <span className={styles.resultMeta}>{hit.relative}</span>
                <span className={`${styles.snippet} ${styles.mono}`}>{highlight(hit.text, props.query, hit.col)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {props.showCommands && props.commandResults.length > 0 && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>{t("search.scope.commands")}</div>
          {props.commandResults.map((result) => (
            <button key={result.id} data-search-result className={styles.result} onClick={() => props.onPaletteResult(result)} onKeyDown={keyDown} aria-label={`${result.title} ${result.subtitle}`}>
              <span className={styles.resultIcon}>›</span>
              <span className={styles.resultBody}>
                <span className={styles.resultTitle}>{result.title}</span>
                <span className={styles.resultMeta}>{result.subtitle}</span>
              </span>
              {result.hint && <span className={styles.hint}>{result.hint}</span>}
            </button>
          ))}
        </div>
      )}

      {!props.loading && props.query.length >= 2 && props.visibleResultCount === 0 && (
        <div className={styles.empty}>{t("search.noMatches")}</div>
      )}
    </div>
  );
}

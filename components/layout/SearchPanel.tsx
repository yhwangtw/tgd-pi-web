"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandPaletteApi, PaletteResult } from "@/hooks/useCommandPalette";
import { useUnifiedSearchResults, type SearchScope } from "@/hooks/useUnifiedSearchResults";
import { useI18n, type MsgKey } from "@/lib/i18n";
import styles from "./SearchPanel.module.css";
import { UnifiedSearchResults } from "./UnifiedSearchResults";

interface Props {
  cwd: string | null;
  palette: CommandPaletteApi;
  focusSignal: number;
  onSelectSession: (sessionId: string) => void;
  onSelectTag: (tag: string) => void;
  onOpenFile: (filePath: string, fileName: string, line?: number) => void;
}

const SCOPES: SearchScope[] = ["all", "semantic", "sessions", "files", "content", "commands"];

/**
 * One search surface for sessions, recursive file names, file contents, tags,
 * and commands. The rail Search button and Command-K both focus this panel.
 */
export function SearchPanel({ cwd, palette, focusSignal, onSelectSession, onSelectTag, onOpenFile }: Props) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<SearchScope>("all");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const query = palette.query;
  const trimmed = query.trim();
  const { sessionHits, fileHits, contentHits, semanticHits, loading, error } = useUnifiedSearchResults(
    cwd,
    trimmed,
    scope,
    caseSensitive,
  );

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [focusSignal]);

  const commandResults = useMemo(
    () => palette.results.filter((result) => result.kind === "action"),
    [palette.results],
  );
  const tagResults = useMemo(
    () => palette.results.filter((result) => result.kind === "tag"),
    [palette.results],
  );
  const visibleCommandResults = useMemo(
    () => trimmed || scope === "commands" ? commandResults : commandResults.slice(0, 6),
    [commandResults, scope, trimmed],
  );

  const showSessions = scope === "all" || scope === "sessions";
  const showFiles = scope === "all" || scope === "files";
  const showContent = scope === "all" || scope === "content";
  const showCommands = scope === "all" || scope === "commands";
  const showSemantic = scope === "semantic";
  const visibleResultCount =
    (showSemantic ? semanticHits.length : 0)
    +
    (showSessions ? sessionHits.length + tagResults.length : 0)
    + (showFiles ? fileHits.length : 0)
    + (showContent ? contentHits.length : 0)
    + (showCommands ? visibleCommandResults.length : 0);

  const runPaletteResult = (result: PaletteResult) => {
    if (result.kind === "tag") onSelectTag((result.data as { tag: string }).tag);
    else if (result.kind === "action") palette.runAction(result);
  };

  return (
    <section className={styles.root} data-testid="unified-search">
      <div className={styles.header}>
        <div className={`${styles.title} chrome-mono`}>{t("search.unifiedTitle")}</div>
        <div className={styles.inputRow}>
          <span className={styles.searchIcon} aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(e) => palette.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                palette.setQuery("");
                return;
              }
              if (e.key === "ArrowDown" || e.key === "Enter") {
                e.preventDefault();
                const firstResult = inputRef.current
                  ?.closest("[data-testid='unified-search']")
                  ?.querySelector<HTMLButtonElement>("[data-unified-results] [data-search-result]");
                if (e.key === "Enter") firstResult?.click();
                else firstResult?.focus();
              }
            }}
            placeholder={t("search.unifiedPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            aria-label="Unified search"
          />
          {query && (
            <button className={styles.clearButton} onClick={() => palette.setQuery("")} aria-label={t("search.clear")}>
              ×
            </button>
          )}
        </div>
        <div className={styles.scopes} aria-label={t("search.scopes")}>
          {SCOPES.map((item) => (
            <button
              key={item}
              className={`${styles.scope} ${scope === item ? styles.scopeActive : ""}`}
              onClick={() => setScope(item)}
              aria-pressed={scope === item}
            >
              {t(`search.scope.${item}` as MsgKey)}
            </button>
          ))}
        </div>
        {(scope === "all" || scope === "content") && (
          <button
            className={`${styles.caseButton} ${caseSensitive ? styles.caseButtonActive : ""}`}
            onClick={() => setCaseSensitive((value) => !value)}
            aria-pressed={caseSensitive}
            title={t("search.caseSensitive")}
          >
            Aa
          </button>
        )}
      </div>

      <div className={styles.status} role="status">
        {loading
          ? t("search.searching")
          : error
            ? t("search.partialError")
            : trimmed.length === 1 && scope !== "commands"
              ? t("search.minChars")
              : trimmed.length >= 2
                ? `${visibleResultCount} ${t("search.results")}`
                : t("search.startTyping")}
      </div>

      <UnifiedSearchResults
        query={trimmed}
        loading={loading}
        visibleResultCount={visibleResultCount}
        showSessions={showSessions}
        showFiles={showFiles}
        showContent={showContent}
        showCommands={showCommands}
        showSemantic={showSemantic}
        sessionHits={sessionHits}
        fileHits={fileHits}
        contentHits={contentHits}
        semanticHits={semanticHits}
        tagResults={tagResults}
        commandResults={visibleCommandResults}
        inputRef={inputRef}
        onPaletteResult={runPaletteResult}
        onSelectSession={onSelectSession}
        onOpenFile={onOpenFile}
      />
    </section>
  );
}

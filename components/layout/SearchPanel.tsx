"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandPaletteApi, PaletteResult } from "@/hooks/useCommandPalette";
import { useUnifiedSearchResults, type SearchScope } from "@/hooks/useUnifiedSearchResults";
import { useWorkspaceIdentities } from "@/hooks/useWorkspaceIdentities";
import { useI18n, type MsgKey } from "@/lib/i18n";
import { countSessionSearchFilters, EMPTY_SESSION_SEARCH_FILTERS, matchesSessionSearchFilters, sessionBranchFilterValue, type SearchDateRange, type SessionSearchFilters } from "@/lib/search-filters";
import { DEFAULT_FILE_SEARCH_OPTIONS, normalizeFileSearchOptions, type FileSearchOptions } from "@/lib/file-search-options";
import type { SessionSearchStatus } from "@/lib/session-search";
import { DialogShell } from "@/components/ui/DialogShell";
import { BookmarkPlus, Search, SlidersHorizontal, X } from "lucide-react";
import styles from "./SearchPanel.module.css";
import { UnifiedSearchResults } from "./UnifiedSearchResults";
import type { FileOpenOrigin } from "@/lib/file-open";
import { createSavedSearchView, deleteSavedSearchView, readSavedSearchViews, type SavedSearchView } from "@/lib/saved-search-views";

interface Props {
  cwd: string | null;
  palette: CommandPaletteApi;
  focusSignal: number;
  onSelectSession: (sessionId: string) => void;
  onSelectTag: (tag: string) => void;
  onOpenFile: (filePath: string, fileName: string, line?: number, origin?: FileOpenOrigin) => void;
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
  const [fileOptions, setFileOptions] = useState(DEFAULT_FILE_SEARCH_OPTIONS);
  const [fileScopeOpen, setFileScopeOpen] = useState(false);
  const fileOptionCount = Object.values(fileOptions).filter(Boolean).length + Number(caseSensitive);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sessionFilters, setSessionFilters] = useState<SessionSearchFilters>(EMPTY_SESSION_SEARCH_FILTERS);
  const [savedViews, setSavedViews] = useState<SavedSearchView[]>(() => readSavedSearchViews());
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [viewName, setViewName] = useState("");
  const query = palette.query;
  const trimmed = query.trim();
  const { sessionHits, fileHits, contentHits, semanticHits, loading, error, filesTruncated, contentTruncated } = useUnifiedSearchResults(
    cwd,
    trimmed,
    scope,
    caseSensitive,
    fileOptions,
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

  const sessionCwds = useMemo(() => [...new Set(sessionHits.map((hit) => hit.cwd).filter(Boolean))], [sessionHits]);
  const workspaceIdentities = useWorkspaceIdentities(sessionCwds);
  const filteredSessionHits = useMemo(
    () => sessionHits.filter((hit) => matchesSessionSearchFilters(hit, workspaceIdentities[hit.cwd], sessionFilters)),
    [sessionFilters, sessionHits, workspaceIdentities],
  );
  const filterCount = countSessionSearchFilters(sessionFilters);
  const repositories = useMemo(() => [...new Set(sessionHits.map((hit) => workspaceIdentities[hit.cwd]?.repository).filter((value): value is string => Boolean(value)))].sort(), [sessionHits, workspaceIdentities]);
  const branches = useMemo(() => [...new Set(sessionHits.map((hit) => sessionBranchFilterValue(workspaceIdentities[hit.cwd])).filter((value): value is string => value !== null))].sort(), [sessionHits, workspaceIdentities]);
  const models = useMemo(() => [...new Set(sessionHits.map((hit) => hit.modelId).filter((value): value is string => Boolean(value)))].sort(), [sessionHits]);
  const statuses = useMemo(() => [...new Set(sessionHits.map((hit) => hit.status))].sort(), [sessionHits]);

  const showSessions = scope === "all" || scope === "sessions";
  const showFiles = scope === "all" || scope === "files";
  const showContent = scope === "all" || scope === "content";
  const showCommands = scope === "all" || scope === "commands";
  const showSemantic = scope === "semantic";
  const visibleResultCount =
    (showSemantic ? semanticHits.length : 0)
    +
    (showSessions ? Math.min(20, filteredSessionHits.length) + tagResults.length : 0)
    + (showFiles ? fileHits.length : 0)
    + (showContent ? contentHits.length : 0)
    + (showCommands ? visibleCommandResults.length : 0);

  const runPaletteResult = (result: PaletteResult) => {
    if (result.kind === "tag") onSelectTag((result.data as { tag: string }).tag);
    else if (result.kind === "action") palette.runAction(result);
  };

  const applySavedView = (view: SavedSearchView) => {
    setScope(view.scope);
    setSessionFilters(view.filters);
    setFileOptions(normalizeFileSearchOptions(view.fileOptions));
    setCaseSensitive(view.caseSensitive === true);
    palette.setQuery(view.query);
  };

  const saveCurrentView = () => {
    const next = createSavedSearchView({ name: viewName, scope, query: trimmed, filters: sessionFilters, fileOptions, caseSensitive }, savedViews);
    setSavedViews(next);
    setViewName("");
    setSaveViewOpen(false);
  };

  return (
    <section className={styles.root} data-testid="unified-search">
      <div className={styles.header}>
        <div className={`${styles.title} chrome-mono`}>{t("search.unifiedTitle")}</div>
        <div className={styles.inputRow}>
          <span className={styles.searchIcon} aria-hidden><Search size={15} strokeWidth={1.8} /></span>
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
            aria-label={t("search.unifiedTitle")}
          />
          {query && (
            <button className={styles.clearButton} onClick={() => palette.setQuery("")} aria-label={t("search.clear")}>
              <X size={15} strokeWidth={1.8} aria-hidden />
            </button>
          )}
        </div>
        <div className={styles.scopes} role="group" aria-label={t("search.scopes")}>
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
        <div className={styles.filterActions}>
        {showSessions && (
          <button
            type="button"
            className={`${styles.filterButton} ${filterCount > 0 ? styles.filterButtonActive : ""}`}
            onClick={() => setFiltersOpen(true)}
            aria-label={t("search.filters")}
            aria-haspopup="dialog"
          >
            <SlidersHorizontal size={14} strokeWidth={1.8} aria-hidden />
            <span>{t("search.filters")}</span>
            {filterCount > 0 && <strong>{filterCount}</strong>}
          </button>
        )}
        {(showFiles || showContent) && (
          <button type="button" className={`${styles.filterButton} ${fileOptionCount ? styles.filterButtonActive : ""}`} onClick={() => setFileScopeOpen(true)} aria-haspopup="dialog" disabled={!cwd}>
            <SlidersHorizontal size={14} aria-hidden />
            <span>{t("search.fileScope")}</span>
            {fileOptionCount > 0 && <strong>{fileOptionCount}</strong>}
          </button>
        )}
        </div>
        {(showFiles || showContent) && <p className={styles.scopeHint} title={cwd ?? undefined}>
          {cwd ? `${t("search.filesIn")} ${cwd.split(/[\\/]/).filter(Boolean).pop()}` : t("search.chooseWorkspace")}
        </p>}
        {showSessions && filterCount > 0 && (
          <div className={styles.activeFilters} aria-label={t("search.activeFilters")}>
            {sessionFilters.repository && <button onClick={() => setSessionFilters((value) => ({ ...value, repository: null }))}>{sessionFilters.repository}<X size={12} aria-hidden /></button>}
            {sessionFilters.branch && <button onClick={() => setSessionFilters((value) => ({ ...value, branch: null }))}>{sessionFilters.branch === "not-git" ? t("topbar.notGitRepository") : sessionFilters.branch}<X size={12} aria-hidden /></button>}
            {sessionFilters.model && <button onClick={() => setSessionFilters((value) => ({ ...value, model: null }))}>{sessionFilters.model}<X size={12} aria-hidden /></button>}
            {sessionFilters.status && <button onClick={() => setSessionFilters((value) => ({ ...value, status: null }))}>{t(`search.status.${sessionFilters.status}` as MsgKey)}<X size={12} aria-hidden /></button>}
            {sessionFilters.date !== "any" && <button onClick={() => setSessionFilters((value) => ({ ...value, date: "any" }))}>{t(`search.date.${sessionFilters.date}` as MsgKey)}<X size={12} aria-hidden /></button>}
          </div>
        )}
        <div className={styles.savedViews} aria-label={t("search.savedViews")}>
          <span>{t("search.savedViews")}</span>
          {savedViews.map((view) => (
            <div className={styles.savedViewChip} key={view.id}>
              <button type="button" onClick={() => applySavedView(view)} title={view.name}>{view.name}</button>
              <button
                type="button"
                className={styles.savedViewDelete}
                aria-label={t("search.deleteSavedView").replace("{name}", view.name)}
                onClick={() => setSavedViews(deleteSavedSearchView(view.id, savedViews))}
              >
                <X size={12} strokeWidth={2} aria-hidden />
              </button>
            </div>
          ))}
          <button type="button" className={styles.saveViewButton} onClick={() => setSaveViewOpen(true)} disabled={!trimmed && filterCount === 0 && fileOptionCount === 0 && !caseSensitive}>
            <BookmarkPlus size={13} strokeWidth={1.8} aria-hidden />
            {t("search.saveView")}
          </button>
        </div>
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
        {!loading && (filesTruncated || contentTruncated) && <span className={styles.limitNote}>{t("search.limitedResults")}</span>}
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
        sessionHits={filteredSessionHits}
        fileHits={fileHits}
        contentHits={contentHits}
        semanticHits={semanticHits}
        tagResults={tagResults}
        commandResults={visibleCommandResults}
        inputRef={inputRef}
        onPaletteResult={runPaletteResult}
        onSelectSession={onSelectSession}
        onOpenFile={onOpenFile}
        workspaceIdentities={workspaceIdentities}
      />

      <DialogShell open={fileScopeOpen} title={t("search.fileScope")} description={t("search.fileScopeDescription")} onClose={() => setFileScopeOpen(false)} size="compact" mobileMode="sheet" footer={(
        <>
          <button type="button" className={styles.filterSecondary} onClick={() => { setFileOptions(DEFAULT_FILE_SEARCH_OPTIONS); setCaseSensitive(false); }}>{t("search.resetFileScope")}</button>
          <button type="button" className={styles.filterPrimary} onClick={() => setFileScopeOpen(false)}>{t("common.done")}</button>
        </>
      )}>
        <div className={styles.fileScopeForm}>
          <div className={styles.workspacePath}><span>{t("search.currentFolder")}</span><code>{cwd}</code></div>
          <fieldset>
            <legend>{t("search.includeFiles")}</legend>
            {(["includeHidden", "includeIgnored", "includeWorktrees"] as (keyof FileSearchOptions)[]).map((option) => (
              <label key={option}>
                <input type="checkbox" checked={fileOptions[option]} onChange={(event) => setFileOptions((value) => ({ ...value, [option]: event.target.checked }))} />
                <span>{t(`search.${option}` as MsgKey)}</span>
              </label>
            ))}
          </fieldset>
          <label>
            <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />
            <span>{t("search.contentMatchCase")}</span>
          </label>
          <p className={styles.scopeHint}>{t("search.fileScopeLimits")}</p>
        </div>
      </DialogShell>

      <DialogShell
        open={filtersOpen}
        title={t("search.filters")}
        description={t("search.filtersDescription")}
        onClose={() => setFiltersOpen(false)}
        size="compact"
        footer={(
          <>
            <button type="button" className={styles.filterSecondary} onClick={() => setSessionFilters(EMPTY_SESSION_SEARCH_FILTERS)} disabled={filterCount === 0}>{t("sidebar.clearFilters")}</button>
            <button type="button" className={styles.filterPrimary} onClick={() => setFiltersOpen(false)}>{t("common.done")}</button>
          </>
        )}
      >
        <div className={styles.filterGrid}>
          <label><span>{t("search.repository")}</span><select value={sessionFilters.repository ?? ""} onChange={(event) => setSessionFilters((value) => ({ ...value, repository: event.target.value || null }))}><option value="">{t("search.any")}</option>{repositories.map((repository) => <option key={repository} value={repository}>{repository}</option>)}</select></label>
          <label><span>{t("topbar.branch")}</span><select value={sessionFilters.branch ?? ""} onChange={(event) => setSessionFilters((value) => ({ ...value, branch: event.target.value || null }))}><option value="">{t("search.any")}</option>{branches.map((branch) => <option key={branch} value={branch}>{branch === "not-git" ? t("topbar.notGitRepository") : branch}</option>)}</select></label>
          <label><span>{t("search.model")}</span><select value={sessionFilters.model ?? ""} onChange={(event) => setSessionFilters((value) => ({ ...value, model: event.target.value || null }))}><option value="">{t("search.any")}</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
          <label><span>{t("search.status")}</span><select value={sessionFilters.status ?? ""} onChange={(event) => setSessionFilters((value) => ({ ...value, status: (event.target.value || null) as SessionSearchStatus | null }))}><option value="">{t("search.any")}</option>{statuses.map((status) => <option key={status} value={status}>{t(`search.status.${status}` as MsgKey)}</option>)}</select></label>
          <label><span>{t("search.date")}</span><select value={sessionFilters.date} onChange={(event) => setSessionFilters((value) => ({ ...value, date: event.target.value as SearchDateRange }))}><option value="any">{t("search.date.any")}</option><option value="today">{t("search.date.today")}</option><option value="7d">{t("search.date.7d")}</option><option value="30d">{t("search.date.30d")}</option></select></label>
        </div>
      </DialogShell>

      <DialogShell
        open={saveViewOpen}
        title={t("search.saveViewTitle")}
        description={t("search.saveViewDescription")}
        onClose={() => { setSaveViewOpen(false); setViewName(""); }}
        size="compact"
        mobileMode="sheet"
        footer={(
          <>
            <button type="button" className={styles.filterSecondary} onClick={() => { setSaveViewOpen(false); setViewName(""); }}>{t("common.cancel")}</button>
            <button type="button" className={styles.filterPrimary} onClick={saveCurrentView} disabled={!viewName.trim()}>{t("search.saveViewConfirm")}</button>
          </>
        )}
      >
        <label className={styles.saveViewField}>
          <span>{t("search.viewName")}</span>
          <input autoFocus value={viewName} maxLength={60} onChange={(event) => setViewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && viewName.trim()) saveCurrentView(); }} placeholder={t("search.viewNamePlaceholder")} />
        </label>
      </DialogShell>
    </section>
  );
}

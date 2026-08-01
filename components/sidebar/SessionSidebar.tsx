"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { SessionInfo } from "@/lib/types";
import { FileExplorer } from "./FileExplorer";
import { getRecentCwds, getSessionDateGroup, buildSessionTree, type SessionSortMode } from "./session-utils";
import { PiAgentTitle } from "./PiAgentTitle";
import { SessionTreeItem } from "./SessionTreeItem";
import { CwdPicker } from "./CwdPicker";
import { useSessions } from "@/hooks/useSessions";
import { useCwd } from "@/hooks/useCwd";
import { useExplorer } from "@/hooks/useExplorer";
import { useTags } from "@/hooks/useTags";
import { useToast } from "@/hooks/useToast";
import { useI18n, translate, type MsgKey } from "@/lib/i18n";
import { TagFilter } from "./TagFilter";
import { resolveSessionForRestore } from "./session-restore";
import { SessionItemSkeleton } from "@/components/ui/Skeleton";
import styles from "./SessionSidebar.module.css";

const SORT_MODE_KEY = "pi-session-sort";

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  explorerRefreshKey?: number;
  onAtMention?: (relativePath: string) => void;
  onOpenDiff?: (relativePath: string) => void;
  onOpenParallel?: (session: SessionInfo) => void;
  parallelSessionIds?: string[];
  activeTagFilter?: string | null;
  onSelectTagFilter?: (tag: string | null) => void;
  /** The Files rail view owns the tree now; pass false to hide the embedded one. */
  showExplorer?: boolean;
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onAtMention, onOpenDiff, onOpenParallel, parallelSessionIds, activeTagFilter: activeTagFilterProp, onSelectTagFilter, showExplorer = true }: Props) {
  const { allSessions, loading, error, pinnedIds, sessionRefreshDone, loadSessions, handlePinToggle, archivedIds, handleArchiveToggle } = useSessions(refreshKey);
  const { state: cwdState, actions: cwdActions, refs: cwdRefs } = useCwd(onCwdChange);
  const { selectedCwd } = cwdState;
  const { setSelectedCwd } = cwdActions;
  const { explorerOpen, explorerKey, explorerRefreshDone, toggleExplorer, refreshExplorer } = useExplorer(explorerRefreshKey);
  const { tags, setTag, removeTag, sessionTagsOf } = useTags();
  const { showToast } = useToast();
  const { t } = useI18n();
  // Tag filter can be lifted to the parent (e.g. for ⌘K palette control).
  const [localActiveTagFilter, setLocalActiveTagFilter] = useState<string | null>(null);
  const activeTagFilter = activeTagFilterProp ?? localActiveTagFilter;
  const setActiveTagFilter = onSelectTagFilter ?? setLocalActiveTagFilter;

  const restoredSessionIdRef = useRef<string | null>(null);
  const restoreFallbackCwdRef = useRef<string | null>(null);

  // Follow the active session's cwd. Selecting a session from another project
  // (e.g. via the ⌘K palette) must move the whole sidebar — project picker and
  // session list included — otherwise they keep showing the previous project
  // while the chat and file explorer have already switched.
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== selectedCwd) {
      setSelectedCwd(selectedCwdProp);
    }
    // Only react to prop changes; internal picker changes flow the other way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCwdProp]);

  // Auto-select cwd and restore the session selected by the URL. The list is
  // incremental and can briefly miss a newly-created session, so fall back to
  // its detail endpoint instead of permanently abandoning the restore.
  useEffect(() => {
    if (loading) return;

    if (initialSessionId) {
      if (selectedSessionId === initialSessionId) {
        restoredSessionIdRef.current = initialSessionId;
        restoreFallbackCwdRef.current = null;
        return;
      }
      if (restoredSessionIdRef.current === initialSessionId) {
        if (restoreFallbackCwdRef.current === selectedCwd) {
          restoreFallbackCwdRef.current = null;
          onInitialRestoreDone?.();
        }
        return;
      }

      let cancelled = false;
      void resolveSessionForRestore(initialSessionId, allSessions).then((target) => {
        if (cancelled) return;
        restoredSessionIdRef.current = initialSessionId;
        if (target) {
          restoreFallbackCwdRef.current = null;
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        if (selectedCwd === null) {
          const cwds = getRecentCwds(allSessions);
          if (cwds.length > 0) {
            restoreFallbackCwdRef.current = cwds[0];
            setSelectedCwd(cwds[0]);
            return;
          }
        }
        onInitialRestoreDone?.();
      }).catch(() => {
        if (!cancelled) onInitialRestoreDone?.();
      });
      return () => { cancelled = true; };
    }

    restoredSessionIdRef.current = null;
    restoreFallbackCwdRef.current = null;
    if (selectedCwd === null) {
      const cwds = getRecentCwds(allSessions);
      if (cwds.length > 0) {
        setSelectedCwd(cwds[0]);
        return;
      }
    }
    onInitialRestoreDone?.();
  }, [allSessions, loading, selectedCwd, selectedSessionId, initialSessionId, onSelectSession, onInitialRestoreDone, setSelectedCwd]);

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, selectedCwd);
  }, [selectedCwd, onNewSession]);

  // All known projects (cwd + session count), most recently used first.
  const projects = useMemo(() => {
    const byCwd = new Map<string, { count: number; latest: string }>();
    for (const s of allSessions) {
      if (!s.cwd) continue;
      const entry = byCwd.get(s.cwd);
      if (entry) {
        entry.count++;
        if (s.modified > entry.latest) entry.latest = s.modified;
      } else {
        byCwd.set(s.cwd, { count: 1, latest: s.modified });
      }
    }
    return [...byCwd.entries()]
      .sort((a, b) => b[1].latest.localeCompare(a[1].latest))
      .map(([cwd, { count }]) => ({ cwd, count }));
  }, [allSessions]);
  // ── Sort mode: recent (default) / name / messages, persisted locally ──
  const [sortMode, setSortMode] = useState<SessionSortMode>("recent");
  useEffect(() => {
    try {
      const v = localStorage.getItem(SORT_MODE_KEY);
      if (v === "name" || v === "messages" || v === "recent") setSortMode(v);
    } catch { /* private mode */ }
  }, []);
  const cycleSortMode = useCallback(() => {
    setSortMode((m) => {
      const next: SessionSortMode = m === "recent" ? "name" : m === "name" ? "messages" : "recent";
      try { localStorage.setItem(SORT_MODE_KEY, next); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const [showArchived, setShowArchived] = useState(false);
  const archivedSet = useMemo(() => new Set(archivedIds), [archivedIds]);
  const archivedCount = useMemo(
    () => allSessions.filter((s) => archivedSet.has(s.id) && (!selectedCwd || s.cwd === selectedCwd)).length,
    [allSessions, archivedSet, selectedCwd],
  );

  const filteredSessions = useMemo(() => {
    let list = selectedCwd
      ? allSessions.filter((s) => s.cwd === selectedCwd)
      : allSessions;
    if (!showArchived) {
      list = list.filter((s) => !archivedSet.has(s.id));
    }
    if (activeTagFilter) {
      const tagged = tags[activeTagFilter] ?? [];
      list = list.filter((s) => tagged.includes(s.id));
    }
    return list;
  }, [allSessions, selectedCwd, activeTagFilter, tags, showArchived, archivedSet]);

  // Build parent-child tree within the filtered set
  const sessionTree = buildSessionTree(filteredSessions, sortMode);

  // ── Keyboard navigation: ↑/↓ roves focus over visible rows, Enter opens ──
  // DOM order is the source of truth — collapsed fork children aren't
  // rendered, so querying [data-session-row] always matches what's visible.
  const listRef = useRef<HTMLDivElement>(null);
  const moveRowFocus = useCallback((delta: 1 | -1) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-session-row]") ?? []);
    if (!rows.length) return;
    const cur = rows.indexOf(document.activeElement as HTMLElement);
    const next = cur === -1
      ? (delta > 0 ? 0 : rows.length - 1)
      : Math.min(rows.length - 1, Math.max(0, cur + delta));
    rows[next].focus();
    rows[next].scrollIntoView({ block: "nearest" });
  }, []);
  const handleListKeyDown = useCallback((e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    // Inline rename/delete inputs keep their own arrow/Enter behavior.
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    if (e.key === "ArrowDown") { e.preventDefault(); moveRowFocus(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveRowFocus(-1); }
    else if ((e.key === "Enter" || e.key === " ") && target.dataset.sessionRow) {
      e.preventDefault();
      target.click();
    }
  }, [moveRowFocus]);

  // Split into pinned vs unpinned. Pinned sessions float to the top, preserving
  // their order in the pins file (most recently pinned first). Unpinned sessions
  // keep the tree layout (parents + forks) with date group headers.
  const pinnedSet = new Set(pinnedIds);
  const pinnedNodes = pinnedIds
    .map((id) => sessionTree.find((n) => n.session.id === id) ?? null)
    .filter((n): n is NonNullable<typeof n> => n !== null);
  const unpinnedNodes = sessionTree.filter((n) => !pinnedSet.has(n.session.id));

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <PiAgentTitle />
          <div className={styles.headerButtons}>
            <button
              onClick={handleNewSession}
              disabled={!selectedCwd}
              className={`${styles.newSessionButton} ${selectedCwd ? styles.newSessionButtonEnabled : styles.newSessionButtonDisabled} hover-bg-selected-accent`}
              title={selectedCwd ? `${t("sidebar.newIn")} ${selectedCwd}` : t("sidebar.selectProjectFirst")}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
              {t("sidebar.new")}
            </button>
            <button
              onClick={() => loadSessions(false)}
              className={`${styles.refreshButton} ${sessionRefreshDone ? styles.refreshButtonDone : styles.refreshButtonDefault} ${sessionRefreshDone ? "" : "hover-bg-selected-accent"}`}
              title={t("sidebar.refresh")}
            >
              {sessionRefreshDone ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* CWD picker */}
        <CwdPicker
          state={cwdState}
          actions={cwdActions}
          refs={cwdRefs}
          projects={projects}
          initialSessionId={initialSessionId ?? null}
          isRestoring={restoredSessionIdRef.current === initialSessionId}
        />
      </div>

      {/* Session-list controls; search lives in the global Search rail view. */}
      <div className={styles.sessionToolbar}>
        <div className={styles.sessionToolbarRow}>
          <span className={`${styles.sessionListLabel} chrome-mono`}>{t("search.scope.sessions")}</span>
          <button
            onClick={cycleSortMode}
            className={`${styles.sortButton} ${sortMode !== "recent" ? styles.sortButtonActive : ""} hover-bg-selected-accent`}
            title={`${t("sidebar.sortBy")}: ${t(sortMode === "recent" ? "sidebar.sortRecent" : sortMode === "name" ? "sidebar.sortName" : "sidebar.sortMessages")}`}
            aria-label="Sort sessions"
          >
            {sortMode === "recent" ? (
              /* clock */
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" />
              </svg>
            ) : sortMode === "name" ? (
              /* A→Z */
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 18 8 6l4 12" /><line x1="5.3" y1="14" x2="10.7" y2="14" />
                <polyline points="15 8 21 8 15 18 21 18" />
              </svg>
            ) : (
              /* bars (count) */
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="4" y1="19" x2="4" y2="10" /><line x1="10" y1="19" x2="10" y2="5" /><line x1="16" y1="19" x2="16" y2="13" /><line x1="22" y1="19" x2="22" y2="8" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Tag filter chips (visible when user has tagged any session) */}
      {Object.keys(tags).length > 0 && (
        <TagFilter
          tags={tags}
          activeTag={activeTagFilter}
          onSelectTag={setActiveTagFilter}
        />
      )}

      {/* Session list */}
      <div
        ref={listRef}
        role="listbox"
        aria-label={t("sidebar.sessions")}
        tabIndex={0}
        onKeyDown={handleListKeyDown}
        className={styles.sessionList}
        style={{ flex: showExplorer && explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto", outline: "none" }}
      >
        {/* Which project this list is scoped to — makes the picker's filtering visible */}
        {selectedCwd && !loading && !error && (
          <div className={styles.projectScopeLabel}>
            <span className={styles.projectScopeName}>{selectedCwd.split(/[\\/]/).filter(Boolean).pop()}</span>
            <span> · {filteredSessions.length} {t("sidebar.sessionsFound")}</span>
          </div>
        )}
        {loading && (
          <div className={styles.loadingWrapper}>
            <SessionItemSkeleton count={6} />
          </div>
        )}
        {error && (
          <div className={styles.errorMessage}>
            {error}
          </div>
        )}
        {!loading && !error && filteredSessions.length === 0 && (
          <div className={styles.emptyMessage}>
            {t("sidebar.noSessions")}
          </div>
        )}
        {pinnedNodes.length > 0 && (
          <>
            <div className={`${styles.groupHeader} ${styles.groupHeaderDivider}`}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--text-dim)" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                {t("sidebar.pinned")}
              </span>
            </div>
            {pinnedNodes.map((node) => (
              <div key={node.session.id}>
                <SessionTreeItem
                  node={node}
                  selectedSessionId={selectedSessionId}
                  onSelectSession={onSelectSession}
                  onRenamed={loadSessions}
                  onSessionDeleted={(id) => {
                    onSessionDeleted?.(id);
                    loadSessions();
                    showToast(translate("toast.sessionDeleted"), { type: "success" });
                  }}
                  depth={0}
                  isPinned
                  onPinToggle={handlePinToggle}
                  tags={sessionTagsOf(node.session.id)}
                  onSetTag={(tag) => { setTag(node.session.id, tag); showToast(`${translate("toast.tagAdded")} #${tag}`, { type: "success" }); }}
                  onRemoveTag={(tag) => { removeTag(node.session.id, tag); showToast(`${translate("toast.tagRemoved")} #${tag}`, { type: "info" }); }}
                  isParallelOpen={parallelSessionIds?.includes(node.session.id) ?? false}
                  onOpenParallel={onOpenParallel}
                  isArchived={archivedSet.has(node.session.id)}
                  onArchiveToggle={handleArchiveToggle}
                />
              </div>
            ))}
          </>
        )}
        {unpinnedNodes.map((node, idx) => {
          const group = getSessionDateGroup(node.session.modified);
          const prevGroup = idx > 0 ? getSessionDateGroup(unpinnedNodes[idx - 1].session.modified) : null;
          // Date headers only make sense when the list is in recency order.
          const showHeader = sortMode === "recent" && group !== prevGroup;
          // First section never gets a divider (nothing to separate from). Pinned
          // section already adds its own divider; the first unpinned group is
          // the "first" only if there's no Pinned section above it.
          const isFirstSection = idx === 0 && pinnedNodes.length === 0;
          const headerClass = isFirstSection ? styles.groupHeader : `${styles.groupHeader} ${styles.groupHeaderDivider}`;
          return (
            <div key={node.session.id}>
              {showHeader && (
                <div className={headerClass}>
                  {t(`group.${group}` as MsgKey)}
                </div>
              )}
              <SessionTreeItem
                node={node}
                selectedSessionId={selectedSessionId}
                onSelectSession={onSelectSession}
                onRenamed={loadSessions}
                onSessionDeleted={(id) => {
                  onSessionDeleted?.(id);
                  loadSessions();
                  showToast(translate("toast.sessionDeleted"), { type: "success" });
                }}
                depth={0}
                isPinned={false}
                onPinToggle={handlePinToggle}
                tags={sessionTagsOf(node.session.id)}
                onSetTag={(tag) => { setTag(node.session.id, tag); showToast(`${translate("toast.tagAdded")} #${tag}`, { type: "success" }); }}
                onRemoveTag={(tag) => { removeTag(node.session.id, tag); showToast(`${translate("toast.tagRemoved")} #${tag}`, { type: "info" }); }}
                isParallelOpen={parallelSessionIds?.includes(node.session.id) ?? false}
                onOpenParallel={onOpenParallel}
                isArchived={archivedSet.has(node.session.id)}
                onArchiveToggle={handleArchiveToggle}
              />
            </div>
          );
        })}
        {archivedCount > 0 && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className={styles.archivedToggle}
          >
            {showArchived ? t("sidebar.hideArchived") : t("sidebar.showArchived")} ({archivedCount})
          </button>
        )}
      </div>

      {/* File Explorer section */}
      {showExplorer && (selectedCwdProp || selectedCwd) && (
        <div
          className={styles.explorerSection}
          style={{ flex: explorerOpen ? "1 1 0" : "0 0 auto" }}
        >
          <div className={styles.explorerHeader}>
            <button
              onClick={toggleExplorer}
              className={styles.explorerToggle}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                className={styles.explorerChevron}
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none" }}
              >
                <polyline points="3 2 7 5 3 8" />
              </svg>
              {t("sidebar.explorer")}
            </button>
            <button
              onClick={refreshExplorer}
              title={t("sidebar.refreshExplorer")}
              className={`${styles.explorerRefreshButton} ${explorerRefreshDone ? styles.explorerRefreshButtonDone : styles.explorerRefreshButtonDefault} ${explorerRefreshDone ? "" : "hover-bg-selected-accent"}`}
            >
              {explorerRefreshDone ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
          </div>
          {explorerOpen && (
            <div className={styles.explorerContent}>
              <FileExplorer
                cwd={selectedCwdProp ?? selectedCwd!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onOpenDiff={onOpenDiff}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

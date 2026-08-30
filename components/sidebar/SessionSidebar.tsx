"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { SessionInfo } from "@/lib/types";
import { FileExplorer } from "./FileExplorer";
import { getRecentCwds, getSessionDateGroup, getSessionProjectName, buildSessionDisplayTitles, buildSessionTree, findSessionTreeNode, flattenSessionTree, shortenCwd, type FlatSessionTreeNode, type SessionSortMode } from "./session-utils";
import { PiAgentTitle } from "./PiAgentTitle";
import { SessionItem } from "./SessionItem";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { useSessions } from "@/hooks/useSessions";
import { useCwd } from "@/hooks/useCwd";
import { useExplorer } from "@/hooks/useExplorer";
import { useTags } from "@/hooks/useTags";
import { useToast } from "@/hooks/useToast";
import { useI18n, translate, type MsgKey } from "@/lib/i18n";
import { TagFilter } from "./TagFilter";
import { resolveSessionForRestore } from "./session-restore";
import { SessionItemSkeleton } from "@/components/ui/Skeleton";
import { DialogShell } from "@/components/ui/DialogShell";
import { useUnifiedSearchResults } from "@/hooks/useUnifiedSearchResults";
import { useWorkspaceIdentities } from "@/hooks/useWorkspaceIdentities";
import { onOpenProjectSwitcher } from "@/lib/project-switcher-events";
import { computeVirtualWindow } from "@/lib/virtual-list";
import { ArrowDownAZ, BarChart3, Check, ChevronRight, Clock3, FolderGit2, Plus, RefreshCw, Search, SlidersHorizontal, Star, X } from "lucide-react";
import styles from "./SessionSidebar.module.css";

const SORT_MODE_KEY = "pi-session-sort";
const SESSION_SCOPE_KEY = "pi-session-scope";
type SessionScope = "all" | "project";

type VirtualSessionRow =
  | { type: "group"; key: string; label: MsgKey; divider: boolean }
  | { type: "session"; key: string; flat: FlatSessionTreeNode };

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
  const { state: cwdState, actions: cwdActions } = useCwd(onCwdChange);
  const { selectedCwd } = cwdState;
  const { setSelectedCwd, setDropdownOpen, handleDefaultCwd } = cwdActions;
  const { explorerOpen, explorerKey, explorerRefreshDone, toggleExplorer, refreshExplorer } = useExplorer(explorerRefreshKey);
  const { tags, setTag, removeTag, sessionTagsOf } = useTags();
  const { showToast } = useToast();
  const { t } = useI18n();
  // Tag filter can be lifted to the parent (e.g. for ⌘K palette control).
  const [localActiveTagFilter, setLocalActiveTagFilter] = useState<string | null>(null);
  const activeTagFilter = activeTagFilterProp ?? localActiveTagFilter;
  const setActiveTagFilter = onSelectTagFilter ?? setLocalActiveTagFilter;
  const [sessionScope, setSessionScope] = useState<SessionScope>("all");
  const [sessionQuery, setSessionQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const normalizedSessionQuery = sessionQuery.trim();
  const {
    sessionHits,
    loading: sessionSearchLoading,
    error: sessionSearchError,
  } = useUnifiedSearchResults(null, normalizedSessionQuery, "sessions", false);

  const pickProjectPath = useCallback(async (path: string): Promise<string | null> => {
    try {
      const response = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!response.ok || data.error) return data.error ?? `HTTP ${response.status}`;
      setSelectedCwd(data.cwd ?? path);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, [setSelectedCwd]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setDropdownOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setDropdownOpen]);

  useEffect(() => onOpenProjectSwitcher(() => setDropdownOpen(true)), [setDropdownOpen]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SESSION_SCOPE_KEY);
      if (saved === "all" || saved === "project") setSessionScope(saved);
    } catch { /* private mode */ }
  }, []);

  const selectSessionScope = useCallback((scope: SessionScope) => {
    setSessionScope(scope);
    try { localStorage.setItem(SESSION_SCOPE_KEY, scope); } catch { /* private mode */ }
  }, []);

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
    () => allSessions.filter((s) => archivedSet.has(s.id) && (sessionScope === "all" || !selectedCwd || s.cwd === selectedCwd)).length,
    [allSessions, archivedSet, selectedCwd, sessionScope],
  );

  const filteredSessions = useMemo(() => {
    let list = sessionScope === "project" && selectedCwd
      ? allSessions.filter((s) => s.cwd === selectedCwd)
      : allSessions;
    if (!showArchived) {
      list = list.filter((s) => !archivedSet.has(s.id));
    }
    if (activeTagFilter) {
      const tagged = tags[activeTagFilter] ?? [];
      list = list.filter((s) => tagged.includes(s.id));
    }

    if (normalizedSessionQuery) {
      if (normalizedSessionQuery.length === 1 || sessionSearchError) {
        const query = normalizedSessionQuery.toLocaleLowerCase();
        list = list.filter((session) =>
          `${session.name ?? ""}\n${session.firstMessage}`.toLocaleLowerCase().includes(query),
        );
      } else if (sessionSearchLoading) {
        list = [];
      } else {
        const matchingIds = new Set(sessionHits.map((hit) => hit.id));
        list = list.filter((session) => matchingIds.has(session.id));
      }
    }
    return list;
  }, [allSessions, selectedCwd, sessionScope, activeTagFilter, tags, showArchived, archivedSet, normalizedSessionQuery, sessionSearchError, sessionSearchLoading, sessionHits]);

  // Build parent-child tree within the filtered set
  const sessionTree = useMemo(() => buildSessionTree(filteredSessions, sortMode), [filteredSessions, sortMode]);
  const displayTitles = useMemo(() => buildSessionDisplayTitles(filteredSessions, 52), [filteredSessions]);
  const workspaceCwds = useMemo(() => [...new Set(filteredSessions.map((session) => session.cwd).filter(Boolean))], [filteredSessions]);
  const workspaceIdentities = useWorkspaceIdentities(workspaceCwds, refreshKey ?? 0);
  const activeFilterCount = Number(Boolean(activeTagFilter)) + Number(showArchived);

  // Pinned conversations stay outside the virtualized chronological list.
  // Recursive lookup also allows a fork itself to be pinned (the previous
  // root-only lookup silently dropped pinned forks).
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const pinnedNodes = useMemo(() => {
    const seen = new Set<string>();
    const result: NonNullable<ReturnType<typeof findSessionTreeNode>>[] = [];
    for (const id of pinnedIds) {
      const node = findSessionTreeNode(sessionTree, id);
      if (!node || seen.has(node.session.id)) continue;
      seen.add(node.session.id);
      result.push(node);
    }
    return result;
  }, [pinnedIds, sessionTree]);
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<Set<string>>(() => new Set());
  const toggleSessionCollapsed = useCallback((id: string) => {
    setCollapsedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const unpinnedFlatNodes = useMemo(
    () => flattenSessionTree(sessionTree, collapsedSessionIds, pinnedSet),
    [sessionTree, collapsedSessionIds, pinnedSet],
  );
  const virtualRows = useMemo<VirtualSessionRow[]>(() => {
    const rows: VirtualSessionRow[] = [];
    let previousRootGroup: string | null = null;
    for (const flat of unpinnedFlatNodes) {
      if (sortMode === "recent" && flat.depth === 0) {
        const group = getSessionDateGroup(flat.node.session.modified);
        if (group !== previousRootGroup) {
          rows.push({
            type: "group",
            key: `group:${group}:${flat.node.session.id}`,
            label: `group.${group}` as MsgKey,
            divider: pinnedNodes.length > 0 || previousRootGroup !== null,
          });
          previousRootGroup = group;
        }
      }
      rows.push({ type: "session", key: flat.node.session.id, flat });
    }
    return rows;
  }, [pinnedNodes.length, sortMode, unpinnedFlatNodes]);
  const orderedSessionIds = useMemo(
    () => [
      ...pinnedNodes.map((node) => node.session.id),
      ...virtualRows.flatMap((row) => row.type === "session" ? [row.flat.node.session.id] : []),
    ],
    [pinnedNodes, virtualRows],
  );
  const sessionOrderById = useMemo(
    () => new Map(orderedSessionIds.map((id, index) => [id, index])),
    [orderedSessionIds],
  );
  const virtualRowIndexBySession = useMemo(() => {
    const result = new Map<string, number>();
    virtualRows.forEach((row, index) => {
      if (row.type === "session") result.set(row.flat.node.session.id, index);
    });
    return result;
  }, [virtualRows]);

  // ── Fixed/estimated-height virtualization for hundreds or thousands of
  // conversations. Pinned rows stay mounted; only the chronological portion
  // is windowed. CSS owns the two row-height estimates so typography and
  // mobile changes stay in sync with the calculation.
  const listRef = useRef<HTMLDivElement>(null);
  const virtualContentRef = useRef<HTMLDivElement>(null);
  const [virtualViewport, setVirtualViewport] = useState({ scrollTop: 0, height: 600, rowHeight: 60, groupHeight: 34 });
  const updateVirtualViewport = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const styles = getComputedStyle(list);
    const rowHeight = Number.parseFloat(styles.getPropertyValue("--session-row-height")) || 60;
    const groupHeight = Number.parseFloat(styles.getPropertyValue("--session-group-height")) || 34;
    const sectionTop = virtualContentRef.current?.offsetTop ?? 0;
    const scrollTop = Math.max(0, list.scrollTop - sectionTop);
    const height = list.clientHeight;
    setVirtualViewport((current) => (
      current.scrollTop === scrollTop
      && current.height === height
      && current.rowHeight === rowHeight
      && current.groupHeight === groupHeight
        ? current
        : { scrollTop, height, rowHeight, groupHeight }
    ));
  }, []);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => updateVirtualViewport();
    list.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onScroll);
    resizeObserver?.observe(list);
    const frame = requestAnimationFrame(onScroll);
    return () => {
      cancelAnimationFrame(frame);
      list.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      resizeObserver?.disconnect();
    };
  }, [pinnedNodes.length, updateVirtualViewport, virtualRows.length]);
  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = 0;
    updateVirtualViewport();
  }, [activeTagFilter, normalizedSessionQuery, sessionScope, showArchived, sortMode, updateVirtualViewport]);
  const virtualRowHeights = useMemo(
    () => virtualRows.map((row) => row.type === "group" ? virtualViewport.groupHeight : virtualViewport.rowHeight),
    [virtualRows, virtualViewport.groupHeight, virtualViewport.rowHeight],
  );
  const virtualWindow = useMemo(
    () => computeVirtualWindow(virtualRowHeights, virtualViewport.scrollTop, virtualViewport.height),
    [virtualRowHeights, virtualViewport.height, virtualViewport.scrollTop],
  );
  const visibleVirtualRows = virtualRows.slice(virtualWindow.start, virtualWindow.end);

  // Keyboard navigation uses logical row order rather than rendered DOM order,
  // so ArrowUp/ArrowDown keep working when the next row is outside the window.
  const focusSessionOrder = useCallback((order: number) => {
    const bounded = Math.min(orderedSessionIds.length - 1, Math.max(0, order));
    const sessionId = orderedSessionIds[bounded];
    if (!sessionId) return;
    const findRow = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-session-row]") ?? [])
      .find((row) => row.dataset.sessionRow === sessionId);
    const existing = findRow();
    if (existing) {
      existing.focus();
      existing.scrollIntoView({ block: "nearest" });
      return;
    }
    const virtualIndex = virtualRowIndexBySession.get(sessionId);
    const list = listRef.current;
    const content = virtualContentRef.current;
    if (virtualIndex === undefined || !list || !content) return;
    list.scrollTop = content.offsetTop + (virtualWindow.offsets[virtualIndex] ?? 0) - 8;
    requestAnimationFrame(() => requestAnimationFrame(() => findRow()?.focus()));
  }, [orderedSessionIds, virtualRowIndexBySession, virtualWindow.offsets]);
  const handleListKeyDown = useCallback((e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    // Inline rename/delete inputs keep their own arrow/Enter behavior.
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const row = target.closest<HTMLElement>("[data-session-row]");
    const currentOrder = row?.dataset.sessionOrder === undefined ? -1 : Number(row.dataset.sessionOrder);
    if (e.key === "ArrowDown") { e.preventDefault(); focusSessionOrder(currentOrder < 0 ? 0 : currentOrder + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusSessionOrder(currentOrder < 0 ? orderedSessionIds.length - 1 : currentOrder - 1); }
    else if ((e.key === "Enter" || e.key === " ") && target.dataset.sessionRow) {
      e.preventDefault();
      target.click();
    }
  }, [focusSessionOrder, orderedSessionIds.length]);

  const renderSessionRow = (flat: FlatSessionTreeNode, forcedPinned = false) => {
    const { node, depth } = flat;
    const sessionId = node.session.id;
    const isPinned = forcedPinned || pinnedSet.has(sessionId);
    const hasVisibleChildren = node.children.some((child) => !pinnedSet.has(child.session.id));
    return (
      <div className={styles.sessionRowShell}>
        {depth > 0 && (
          <span
            className={styles.forkLine}
            style={{ left: depth * 12 + 6 }}
            aria-hidden
          />
        )}
        <SessionItem
          session={node.session}
          isSelected={sessionId === selectedSessionId}
          onClick={() => onSelectSession(node.session)}
          onRenamed={loadSessions}
          onDeleted={(id) => {
            onSessionDeleted?.(id);
            loadSessions();
            showToast(translate("toast.sessionDeleted"), { type: "success" });
          }}
          depth={depth}
          hasChildren={!forcedPinned && hasVisibleChildren}
          collapsed={collapsedSessionIds.has(sessionId)}
          onToggleCollapse={() => toggleSessionCollapsed(sessionId)}
          isPinned={isPinned}
          onPinToggle={handlePinToggle}
          tags={sessionTagsOf(sessionId)}
          onSetTag={(tag) => { setTag(sessionId, tag); showToast(`${translate("toast.tagAdded")} #${tag}`, { type: "success" }); }}
          onRemoveTag={(tag) => { removeTag(sessionId, tag); showToast(`${translate("toast.tagRemoved")} #${tag}`, { type: "info" }); }}
          isParallelOpen={parallelSessionIds?.includes(sessionId) ?? false}
          onOpenParallel={onOpenParallel}
          isArchived={archivedSet.has(sessionId)}
          onArchiveToggle={handleArchiveToggle}
          showProject={sessionScope === "all"}
          displayTitle={displayTitles.get(sessionId)}
          workspaceIdentity={workspaceIdentities[node.session.cwd]}
          listOrder={sessionOrderById.get(sessionId)}
        />
      </div>
    );
  };

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
              <Plus size={12} strokeWidth={2.2} aria-hidden="true" />
              {t("sidebar.new")}
            </button>
            <button
              onClick={() => loadSessions(false)}
              className={`${styles.refreshButton} ${sessionRefreshDone ? styles.refreshButtonDone : styles.refreshButtonDefault} ${sessionRefreshDone ? "" : "hover-bg-selected-accent"}`}
              title={t("sidebar.refresh")}
            >
              {sessionRefreshDone ? (
                <Check size={15} color="var(--color-success)" strokeWidth={2.5} aria-hidden="true" />
              ) : (
                <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

      </div>

      {/* Conversation-first controls: search spans every project by default;
          the cwd remains the working location for new sessions and files. */}
      <div className={styles.sessionToolbar}>
        <div className={styles.sessionSearch}>
          <span className={styles.sessionSearchIcon} aria-hidden>
            <Search size={14} strokeWidth={2} />
          </span>
          <input
            value={sessionQuery}
            onChange={(event) => setSessionQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSessionQuery("");
                event.currentTarget.blur();
              }
            }}
            className={styles.sessionSearchInput}
            placeholder={t(sessionScope === "all" ? "sidebar.searchAllSessions" : "sidebar.searchProjectSessions")}
            aria-label={t("sidebar.searchSessions")}
            spellCheck={false}
            autoComplete="off"
          />
          {sessionQuery && (
            <button
              className={styles.sessionSearchClear}
              onClick={() => setSessionQuery("")}
              aria-label={t("search.clear")}
            >
              <X size={14} strokeWidth={2} />
            </button>
          )}
        </div>
        <div className={styles.sessionToolbarRow}>
          <div className={styles.sessionScope} role="group" aria-label={t("sidebar.sessionScope")}>
            <button
              className={`${styles.sessionScopeButton} ${sessionScope === "all" ? styles.sessionScopeButtonActive : ""}`}
              onClick={() => selectSessionScope("all")}
              aria-pressed={sessionScope === "all"}
            >
              {t("sidebar.allSessions")}
            </button>
            <button
              className={`${styles.sessionScopeButton} ${sessionScope === "project" ? styles.sessionScopeButtonActive : ""}`}
              onClick={() => selectSessionScope("project")}
              aria-pressed={sessionScope === "project"}
              disabled={!selectedCwd}
              title={selectedCwd ?? t("sidebar.selectProjectFirst")}
            >
              {t("sidebar.thisProject")}
            </button>
          </div>
          <button
            type="button"
            onClick={cycleSortMode}
            className={`${styles.sortButton} ${sortMode !== "recent" ? styles.sortButtonActive : ""} hover-bg-selected-accent`}
            title={`${t("sidebar.sortBy")}: ${t(sortMode === "recent" ? "sidebar.sortRecent" : sortMode === "name" ? "sidebar.sortName" : "sidebar.sortMessages")}`}
            aria-label={`${t("sidebar.sortBy")}: ${t(sortMode === "recent" ? "sidebar.sortRecent" : sortMode === "name" ? "sidebar.sortName" : "sidebar.sortMessages")}`}
          >
            {sortMode === "recent" ? (
              <Clock3 size={12} strokeWidth={2} aria-hidden="true" />
            ) : sortMode === "name" ? (
              <ArrowDownAZ size={12} strokeWidth={2} aria-hidden="true" />
            ) : (
              <BarChart3 size={12} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            className={`${styles.filterButton} ${activeFilterCount > 0 ? styles.filterButtonActive : ""}`}
            aria-label={t("sidebar.filters")}
            title={t("sidebar.filters")}
          >
            <SlidersHorizontal size={15} strokeWidth={1.8} aria-hidden />
            {activeFilterCount > 0 && <span className={styles.filterCount}>{activeFilterCount}</span>}
          </button>
        </div>
      </div>

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
        {!loading && !error && (
          <div className={styles.projectScopeLabel}>
            <span className={styles.projectScopeName}>
              {sessionScope === "all"
                ? t("sidebar.allProjects")
                : selectedCwd
                  ? getSessionProjectName(selectedCwd)
                  : t("sidebar.noProject")}
            </span>
            <span> · {filteredSessions.length} {t("sidebar.sessionsFound")}</span>
            {normalizedSessionQuery && sessionSearchError && (
              <span className={styles.searchFallback}> · {t("sidebar.searchLimited")}</span>
            )}
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
        {!loading && !error && sessionSearchLoading && normalizedSessionQuery.length >= 2 && (
          <div className={styles.emptyMessage} role="status">
            {t("sidebar.searchingSessions")}
          </div>
        )}
        {!loading && !error && !sessionSearchLoading && filteredSessions.length === 0 && (
          <div className={styles.emptyMessage}>
            {normalizedSessionQuery ? t("sidebar.noMatchingSessions") : t("sidebar.noSessions")}
          </div>
        )}
        {pinnedNodes.length > 0 && (
          <>
            <div className={`${styles.groupHeader} ${styles.groupHeaderDivider}`}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Star size={11} color="var(--text-dim)" fill="var(--text-dim)" strokeWidth={2} aria-hidden="true" />
                {t("sidebar.pinned")}
              </span>
            </div>
            {pinnedNodes.map((node) => (
              <div key={node.session.id} className={styles.pinnedSessionRow}>
                {renderSessionRow({ node, depth: 0 }, true)}
              </div>
            ))}
          </>
        )}
        <div
          ref={virtualContentRef}
          className={styles.virtualSessionContent}
          style={{ height: virtualWindow.totalHeight }}
          data-total-session-rows={unpinnedFlatNodes.length}
          data-rendered-session-rows={visibleVirtualRows.filter((row) => row.type === "session").length}
        >
          <div
            className={styles.virtualSessionWindow}
            style={{ transform: `translateY(${virtualWindow.offsetTop}px)` }}
          >
            {visibleVirtualRows.map((row) => row.type === "group" ? (
              <div
                key={row.key}
                className={`${styles.groupHeader} ${row.divider ? styles.groupHeaderDivider : ""}`}
              >
                {t(row.label)}
              </div>
            ) : (
              <div key={row.key} className={styles.virtualSessionRow}>
                {renderSessionRow(row.flat)}
              </div>
            ))}
          </div>
        </div>
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
              <ChevronRight
                size={9}
                strokeWidth={1.8}
                className={styles.explorerChevron}
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none" }}
                aria-hidden="true"
              />
              {t("sidebar.explorer")}
            </button>
            <button
              onClick={refreshExplorer}
              title={t("sidebar.refreshExplorer")}
              className={`${styles.explorerRefreshButton} ${explorerRefreshDone ? styles.explorerRefreshButtonDone : styles.explorerRefreshButtonDefault} ${explorerRefreshDone ? "" : "hover-bg-selected-accent"}`}
            >
              {explorerRefreshDone ? (
                <Check size={13} color="var(--color-success)" strokeWidth={2.5} aria-hidden="true" />
              ) : (
                <RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
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

      <DialogShell
        open={filtersOpen}
        title={t("sidebar.filters")}
        description={t("sidebar.filtersDescription")}
        onClose={() => setFiltersOpen(false)}
        size="compact"
        mobileMode="sheet"
        footer={(
          <>
            <button
              type="button"
              className={styles.filterFooterSecondary}
              onClick={() => { setActiveTagFilter(null); setShowArchived(false); }}
              disabled={!activeTagFilter && !showArchived}
            >
              {t("sidebar.clearFilters")}
            </button>
            <button type="button" className={styles.filterFooterPrimary} onClick={() => setFiltersOpen(false)}>
              {t("common.done")}
            </button>
          </>
        )}
      >
        <div className={styles.filterBody}>
          <section className={styles.filterSection}>
            <h3>{t("sidebar.workingProject")}</h3>
            <p>{t("sidebar.workingProjectHint")}</p>
            <button
              type="button"
              className={styles.projectFilterButton}
              onClick={() => {
                setFiltersOpen(false);
                requestAnimationFrame(() => setDropdownOpen(true));
              }}
            >
              <FolderGit2 size={18} strokeWidth={1.8} aria-hidden />
              <span className={styles.projectFilterText}>
                <strong>{selectedCwd ? getSessionProjectName(selectedCwd) : t("sidebar.noProject")}</strong>
                <small>{selectedCwd ? shortenCwd(selectedCwd, cwdState.homeDir) : t("sidebar.selectProjectFirst")}</small>
              </span>
              <ChevronRight size={17} strokeWidth={1.8} aria-hidden />
            </button>
          </section>

          {Object.keys(tags).length > 0 && (
            <section className={styles.filterSection}>
              <h3>{t("sidebar.tags")}</h3>
              <TagFilter tags={tags} activeTag={activeTagFilter} onSelectTag={setActiveTagFilter} />
            </section>
          )}

          <section className={styles.filterSection}>
            <h3>{t("sidebar.history")}</h3>
            <button
              type="button"
              className={`${styles.archiveFilter} ${showArchived ? styles.archiveFilterActive : ""}`}
              onClick={() => setShowArchived((value) => !value)}
              aria-pressed={showArchived}
            >
              <span className={styles.archiveCheck}>{showArchived && <Check size={14} strokeWidth={2.2} aria-hidden />}</span>
              <span>
                <strong>{t("sidebar.includeArchived")}</strong>
                <small>{archivedCount} {t("sidebar.archivedConversations")}</small>
              </span>
            </button>
          </section>
        </div>
      </DialogShell>

      <ProjectSwitcher
        open={cwdState.dropdownOpen}
        onClose={() => setDropdownOpen(false)}
        onPick={setSelectedCwd}
        onPickPath={pickProjectPath}
        onDefaultCwd={() => void handleDefaultCwd()}
        projects={projects}
        selectedCwd={selectedCwd}
        homeDir={cwdState.homeDir}
      />
    </div>
  );
}

"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { SessionSidebar } from "../sidebar/SessionSidebar";
import { ChatWindow } from "../chat/ChatWindow";
import { FileViewer } from "./FileViewer";
import { FilesPanel } from "./FilesPanel";
import { SearchPanel } from "./SearchPanel";
import { ChangesPanel } from "./ChangesPanel";
import { TgdArtifactsPanel } from "./TgdArtifactsPanel";
import { AgentDashboardPanel } from "./AgentDashboardPanel";
import { SchedulePanel } from "./SchedulePanel";
import { DiffPanel } from "./DiffPanel";
import { AppearancePanel } from "./AppearancePanel";
import { IconRail, type PanelView } from "./IconRail";
import { MobileNavigation } from "./MobileNavigation";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { TabBar } from "./TabBar";
import { BranchNavigator } from "../chat/BranchNavigator";
import { useTheme } from "@/hooks/useTheme";
import { useAppShellState } from "@/hooks/useAppShellState";
import { useFileTabs } from "@/hooks/useFileTabs";
import { useRightPanelWidth } from "@/hooks/useRightPanelWidth";
import { useSessions } from "@/hooks/useSessions";
import { useTags } from "@/hooks/useTags";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useToast, showToast } from "@/hooks/useToast";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { onOpenFileRequest } from "@/lib/file-links";
import { useI18n, translate } from "@/lib/i18n";
import { toggleAlwaysFollow } from "@/lib/prefs";
import { useTabTitle } from "@/lib/attention";
import { setSkin } from "@/lib/skin";
import { resolveAppShellCenterView } from "./app-shell-view";
import { ErrorBoundary } from "./ErrorBoundary";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ChatInputHandle } from "../chat/ChatInput";
import { getSessionDisplayTitle } from "../sidebar/session-utils";
import s from "./AppShell.module.css";

// Lazy-load heavy modals — they're ~1000 lines each and rarely opened
const ModelsConfig = lazy(() => import("../modals/ModelsConfig").then((m) => ({ default: m.ModelsConfig })));
const SkillsConfig = lazy(() => import("../modals/SkillsConfig").then((m) => ({ default: m.SkillsConfig })));
const ExtensionsConfig = lazy(() => import("../modals/ExtensionsConfig").then((m) => ({ default: m.ExtensionsConfig })));
const PromptsConfig = lazy(() => import("../modals/PromptsConfig").then((m) => ({ default: m.PromptsConfig })));
const AnalyticsModal = lazy(() => import("../modals/AnalyticsModal").then((m) => ({ default: m.AnalyticsModal })));

// Home dir for expanding ~/ file links; fetched once, shared across clicks.
let homeDirPromise: Promise<string | null> | null = null;
function fetchHomeDir(): Promise<string | null> {
  homeDirPromise ??= fetch("/api/home")
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { home?: string } | null) => d?.home ?? null)
    .catch(() => {
      homeDirPromise = null; // transient failure — allow a retry on next click
      return null;
    });
  return homeDirPromise;
}

export function AppShell() {
  const { toggleTheme } = useTheme();
  const { locale, t } = useI18n();
  const { state, actions, refs, topBarRef } = useAppShellState();
  const { fileTabs, activeFileTabId, rightPanelOpen, setRightPanelOpen, setActiveFileTabId, handleOpenFile: openFileTab, handleCloseFileTab, handleCloseOthers, handleCloseAll, handleReorderTabs } = useFileTabs();

  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [extensionsConfigOpen, setExtensionsConfigOpen] = useState(false);
  const [promptsConfigOpen, setPromptsConfigOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [panelView, setPanelView] = useState<PanelView>("sessions");
  const [searchFocusSignal, setSearchFocusSignal] = useState(0);
  const [revealSignal, setRevealSignal] = useState(0);
  const revealInExplorer = useCallback((filePath: string) => {
    setActiveFileTabId(`file:${filePath}`);
    setPanelView("files");
    setSidebarOpen(true);
    setRevealSignal((n) => n + 1);
  }, [setActiveFileTabId]);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
  const [wideChat, setWideChat] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("pi-chat-width") === "wide"; } catch { return false; }
  });
  const toggleChatWidth = useCallback(() => {
    setWideChat((v) => {
      try { localStorage.setItem("pi-chat-width", v ? "normal" : "wide"); } catch { /* ignore */ }
      return !v;
    });
  }, []);

  const { rightWidth, draggingRight, startRightResize, resetRightWidth } = useRightPanelWidth();
  const chatInputRef = useRef<ChatInputHandle | null>(null);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-Hant-TW" : "en";
  }, [locale]);

  // On narrow screens the sidebar is a full-width overlay — starting open
  // would cover the whole app with the toggle button underneath it.
  useLayoutEffect(() => {
    if (window.matchMedia("(max-width: 1024px)").matches) setSidebarOpen(false);
  }, []);

  // Rail behavior: clicking the active view collapses the panel; clicking the
  // other view switches to it (opening the panel if needed).
  const handleRailView = useCallback((view: PanelView) => {
    setMobileActionsOpen(false);
    if (view === "search") setSearchFocusSignal((signal) => signal + 1);
    if (view === panelView) {
      setSidebarOpen((open) => !open);
    } else {
      setPanelView(view);
      setSidebarOpen(true);
    }
  }, [panelView]);

  const handleShowMobileChat = useCallback(() => {
    setSidebarOpen(false);
    setRightPanelOpen(false);
    setMobileActionsOpen(false);
  }, [setRightPanelOpen]);

  const handleOpenDiff = useCallback((filePath: string) => {
    setDiffFile(filePath);
    setRightPanelOpen(true);
  }, [setRightPanelOpen]);

  // On overlay-mode screens, picking or starting a session should reveal the
  // chat it just opened instead of leaving the sidebar covering it.
  const closeSidebarIfOverlay = useCallback(() => {
    if (window.matchMedia("(max-width: 1024px)").matches) setSidebarOpen(false);
  }, []);

  const handleOpenFile = useCallback((filePath: string, fileName: string, gotoLine?: number) => {
    openFileTab(filePath, fileName, gotoLine);
    closeSidebarIfOverlay();
  }, [closeSidebarIfOverlay, openFileTab]);

  const handleSelectSessionFromSidebar = useCallback((session: SessionInfo, isRestore?: boolean) => {
    actions.handleSelectSession(session, isRestore);
    if (!isRestore) closeSidebarIfOverlay();
  }, [actions, closeSidebarIfOverlay]);

  const handleNewSessionFromSidebar = useCallback((sessionId: string, cwd: string) => {
    actions.handleNewSession(sessionId, cwd);
    closeSidebarIfOverlay();
  }, [actions, closeSidebarIfOverlay]);

  // ── ⌘K Command Palette wiring ──────────────────────────────────────────
  const { allSessions } = useSessions(state.refreshKey);
  const { tags } = useTags();
  const { ToastContainer } = useToast();
  const effectiveCwdForPalette = state.activeCwd ?? state.selectedSession?.cwd ?? state.newSessionCwd;

  const palette = useCommandPalette({
    sessions: allSessions,
    tags,
    activeTag: activeTagFilter,
    onClearTag: () => setActiveTagFilter(null),
  });

  // File-path links clicked inside chat messages (MarkdownBody broadcasts;
  // we resolve relative → session cwd, confirm the file exists, then open it
  // in the right-panel viewer — a dead path gets a toast instead of a blank tab).
  useEffect(() => {
    return onOpenFileRequest(async (link) => {
      const cwdBase = effectiveCwdForPalette;
      let abs = link.path;
      if (abs.startsWith("~/")) {
        // Expand against the real home dir — stripping the "~" would alias
        // ~/x to /x, which may exist and silently open the wrong file.
        const home = await fetchHomeDir();
        if (!home) { showToast(`Cannot resolve ${link.path}`, { type: "warning" }); return; }
        abs = `${home.replace(/\/$/, "")}${abs.slice(1)}`;
      }
      if (!abs.startsWith("/")) {
        if (!cwdBase) { showToast(`No project selected to resolve ${link.path}`, { type: "warning" }); return; }
        abs = `${cwdBase.replace(/\/$/, "")}/${abs.replace(/^\.\//, "")}`;
      }
      try {
        const res = await fetch(`/api/files/${encodeFilePathForApi(abs)}?type=meta`);
        if (!res.ok) { showToast(`File not found: ${link.path}`, { type: "warning" }); return; }
      } catch {
        showToast(`File not found: ${link.path}`, { type: "warning" });
        return;
      }
      handleOpenFile(abs, abs.split("/").pop() ?? link.path);
    });
  }, [effectiveCwdForPalette, handleOpenFile]);

  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Global hotkeys. Every hint shown in the ⌘K palette must be bound here —
  // an advertised shortcut that does nothing reads as a broken app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "k" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        palette.open();
        setPanelView("search");
        setSidebarOpen(true);
        setSearchFocusSignal((signal) => signal + 1);
        return;
      }
      // ⇧⌘M — Models (plain ⌘M is the macOS minimize shortcut, unreachable)
      if (key === "m" && e.shiftKey) {
        e.preventDefault();
        setModelsConfigOpen(true);
        return;
      }
      if (key === "/" && !e.shiftKey) {
        e.preventDefault();
        if (effectiveCwdForPalette) setSkillsConfigOpen(true);
        return;
      }
      if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }
      if (key === "\\" && !e.shiftKey) {
        e.preventDefault();
        setRightPanelOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, effectiveCwdForPalette, setRightPanelOpen]);

  // Register the action callbacks the palette can fire.
  useEffect(() => {
    palette.register({
      openModels: () => setModelsConfigOpen(true),
      openSkills: () => setSkillsConfigOpen(true),
      openExtensions: () => setExtensionsConfigOpen(true),
      openPrompts: () => setPromptsConfigOpen(true),
      openAnalytics: () => setAnalyticsOpen(true),
      openAppearance: () => setAppearanceOpen(true),
      toggleTheme: () => toggleTheme(),
      toggleSidebar: () => setSidebarOpen((v) => !v),
      toggleFilePanel: () => setRightPanelOpen((v) => !v),
      toggleChatWidth,
      toggleFollowStream: () => {
        const on = toggleAlwaysFollow();
        showToast(translate(on ? "toast.followOn" : "toast.followOff"));
      },
      setSkin,
      newSession: () => {
        if (!effectiveCwdForPalette) return;
        const tempId = typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
        handleNewSessionFromSidebar(tempId, effectiveCwdForPalette);
      },
      openParallelForActive: () => {
        if (state.selectedSession) actions.openParallel(state.selectedSession);
      },
      openHelp: () => setShortcutsOpen(true),
    });
  }, [palette, toggleTheme, actions, effectiveCwdForPalette, state.selectedSession, setRightPanelOpen, handleNewSessionFromSidebar, toggleChatWidth]);

  // Helper: turn a session id into the full SessionInfo record (palette only
  // stores the id in its data when the user picked it via the palette).
  const handlePaletteSelectSession = useCallback(
    (sessionId: string) => {
      const session = allSessions.find((s) => s.id === sessionId);
      if (session) handleSelectSessionFromSidebar(session);
    },
    [allSessions, handleSelectSessionFromSidebar],
  );

  const handleOpenScheduledSession = useCallback(async (sessionId: string) => {
    const known = allSessions.find((session) => session.id === sessionId);
    if (known) {
      handleSelectSessionFromSidebar(known);
      return;
    }
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { info?: SessionInfo | null };
      if (!payload.info) throw new Error("Session not found");
      handleSelectSessionFromSidebar(payload.info);
      actions.bumpRefreshKey();
    } catch {
      showToast(t("extensionUI.noSession"), { type: "warning" });
    }
  }, [actions, allSessions, handleSelectSessionFromSidebar, t]);

  const handlePaletteSelectTag = useCallback(
    (tag: string) => setActiveTagFilter(tag),
    [],
  );

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    refs.branchLeafChangeFnRef.current?.(leafId);
  }, [refs]);

  const handleBranchDataChange = useCallback(
    (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
      actions.setBranchTree(tree);
      actions.setBranchActiveLeafId(activeLeafId);
      refs.branchLeafChangeFnRef.current = onLeafChange;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actions.setBranchTree, actions.setBranchActiveLeafId, refs.branchLeafChangeFnRef]
  );

  const handleAtMention = useCallback((relativePath: string) => {
    chatInputRef.current?.insertText("`" + relativePath + "`");
  }, []);

  const handleExportSession = useCallback(() => {
    if (!state.selectedSession) return;
    window.location.href = `/api/sessions/${encodeURIComponent(state.selectedSession.id)}/export`;
  }, [state.selectedSession]);

  const handleExportMarkdown = useCallback(() => {
    if (!state.selectedSession) return;
    window.location.href = `/api/sessions/${encodeURIComponent(state.selectedSession.id)}/export-md`;
  }, [state.selectedSession]);

  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuPanelRef = useRef<HTMLDivElement>(null);
  // Portalled to <body> (same lesson as the Branches dropdown, PR #34): the
  // top bar's backdrop-filter traps its stacking context, so a menu hanging
  // below the bar paints *under* the tGD pipeline bar / chat content.
  const [exportMenuPos, setExportMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuPanelRef = useRef<HTMLDivElement>(null);
  const [sessionMenuPos, setSessionMenuPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!sessionMenuOpen) { setSessionMenuPos(null); return; }
    const anchor = sessionMenuRef.current;
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      setSessionMenuPos({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [sessionMenuOpen]);

  useEffect(() => {
    if (!sessionMenuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!sessionMenuRef.current?.contains(target) && !sessionMenuPanelRef.current?.contains(target)) {
        setSessionMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sessionMenuOpen]);

  useEffect(() => {
    if (!exportMenuOpen) { setExportMenuPos(null); return; }
    const anchor = exportMenuRef.current;
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      setExportMenuPos({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [exportMenuOpen]);

  useEffect(() => {
    if (!exportMenuOpen) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!exportMenuRef.current?.contains(t) && !exportMenuPanelRef.current?.contains(t)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [exportMenuOpen]);

  const centerView = resolveAppShellCenterView({
    initialized: state.initialSessionRestored,
    hasSelectedSession: state.selectedSession !== null,
    hasNewSessionCwd: state.newSessionCwd !== null,
    hasActiveCwd: state.activeCwd !== null,
  });
  const effectiveNewSessionCwd = centerView === "new"
    ? state.newSessionCwd
    : null;
  const showChat = centerView === "session" || centerView === "new";

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;

  const panelCwd = state.activeCwd ?? state.selectedSession?.cwd ?? state.newSessionCwd ?? null;

  const sidebarContent = (
    <ErrorBoundary>
      {panelView === "sessions" ? (
        <SessionSidebar
          selectedSessionId={state.selectedSession?.id ?? null}
          onSelectSession={handleSelectSessionFromSidebar}
          onNewSession={handleNewSessionFromSidebar}
          initialSessionId={state.initialSessionId}
          onInitialRestoreDone={actions.handleInitialRestoreDone}
          refreshKey={state.refreshKey}
          onSessionDeleted={actions.handleSessionDeleted}
          selectedCwd={state.selectedSession?.cwd ?? state.newSessionCwd ?? null}
          onCwdChange={actions.handleCwdChange}
          onOpenFile={handleOpenFile}
          explorerRefreshKey={state.explorerRefreshKey}
          onAtMention={handleAtMention}
          onOpenDiff={handleOpenDiff}
          onOpenParallel={actions.openParallel}
          parallelSessionIds={state.parallelSessions.map((s) => s.id)}
          activeTagFilter={activeTagFilter}
          onSelectTagFilter={setActiveTagFilter}
          showExplorer={false}
        />
      ) : panelView === "agents" ? (
        <AgentDashboardPanel
          defaultCwd={panelCwd}
          onOpenSession={handleOpenScheduledSession}
        />
      ) : panelView === "schedule" ? (
        <SchedulePanel
          defaultCwd={panelCwd}
          onOpenSession={handleOpenScheduledSession}
        />
      ) : panelView === "files" ? (
        <FilesPanel
          cwd={panelCwd}
          onOpenFile={handleOpenFile}
          onAtMention={handleAtMention}
          refreshKey={state.explorerRefreshKey}
          onOpenDiff={handleOpenDiff}
          activeFilePath={activeFileTab?.filePath ?? null}
          revealSignal={revealSignal}
        />
      ) : panelView === "search" ? (
        <SearchPanel
          cwd={panelCwd}
          palette={palette}
          focusSignal={searchFocusSignal}
          onSelectSession={handlePaletteSelectSession}
          onSelectTag={(tag) => {
            handlePaletteSelectTag(tag);
            setPanelView("sessions");
          }}
          onOpenFile={handleOpenFile}
        />
      ) : panelView === "tgd" ? (
        <TgdArtifactsPanel
          cwd={panelCwd}
          refreshKey={state.refreshKey}
          onOpenFile={handleOpenFile}
        />
      ) : (
        <ChangesPanel
          cwd={panelCwd}
          sessionId={state.selectedSession?.id ?? null}
          refreshKey={state.refreshKey}
          onOpenDiff={handleOpenDiff}
          selectedPath={diffFile}
        />
      )}
    </ErrorBoundary>
  );

  const tabTitle = useTabTitle();

  return (
    <>
    <title>{tabTitle}</title>
    <div className={s.container} data-testid="app-shell">
      {/* Icon rail — global navigation, always visible */}
      <IconRail
        panelView={panelView}
        sidebarOpen={sidebarOpen}
        onSelectView={handleRailView}
        onOpenAnalytics={() => setAnalyticsOpen(true)}
        onOpenModels={() => setModelsConfigOpen(true)}
        onOpenSkills={() => setSkillsConfigOpen(true)}
        skillsDisabled={!panelCwd}
        onOpenExtensions={() => setExtensionsConfigOpen(true)}
        appearanceOpen={appearanceOpen}
        onToggleAppearance={() => setAppearanceOpen((v) => !v)}
      />
      <MobileNavigation
        panelView={panelView}
        panelOpen={sidebarOpen}
        filePanelOpen={rightPanelOpen}
        onShowChat={handleShowMobileChat}
        onSelectView={handleRailView}
        onOpenAnalytics={() => setAnalyticsOpen(true)}
        onOpenModels={() => setModelsConfigOpen(true)}
        onOpenSkills={() => setSkillsConfigOpen(true)}
        skillsDisabled={!panelCwd}
        onOpenExtensions={() => setExtensionsConfigOpen(true)}
        onOpenAppearance={() => setAppearanceOpen(true)}
      />
      {/* Mobile overlay backdrop */}
      <div
        className="sidebar-overlay-backdrop"
        onClick={() => setSidebarOpen(false)}
        style={{
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
        }}
      />

      {/* Left sidebar */}
      <div
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"} ${s.sidebarContainer}`}
      >
        {sidebarContent}
      </div>

      {/* Center: chat */}
      <div className={s.centerPanel}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} className={s.topBar} data-testid="top-bar">
          <button
            type="button"
            className={s.mobileSessionsButton}
            onClick={() => handleRailView("sessions")}
            aria-label={t("mobile.openSessions")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          <div className={s.chatTitle} title={state.selectedSession ? getSessionDisplayTitle(state.selectedSession, 240) : undefined}>
            {state.selectedSession
              ? getSessionDisplayTitle(state.selectedSession)
              : effectiveNewSessionCwd
                ? t("sidebar.new").toLowerCase() + " · " + (effectiveNewSessionCwd.split("/").pop() ?? "")
                : "π"}
          </div>
          {showChat && (
            <button
              type="button"
              className={s.mobileActionsToggle}
              onClick={() => setMobileActionsOpen((open) => !open)}
              aria-label={t("mobile.sessionActions")}
              aria-expanded={mobileActionsOpen}
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
              </svg>
            </button>
          )}
          {mobileActionsOpen && <button type="button" className={s.mobileActionsBackdrop} onClick={() => setMobileActionsOpen(false)} aria-label={t("mobile.closeActions")} />}
          {showChat && (
            <div className={s.desktopSessionMenu} ref={sessionMenuRef}>
              <button
                type="button"
                className={`${s.sessionMenuButton} ${sessionMenuOpen || state.activeTopPanel ? s.systemButtonActive : s.systemButtonDefault}`}
                onClick={() => setSessionMenuOpen((open) => !open)}
                aria-label={t("topbar.sessionMenuTitle")}
                aria-haspopup="menu"
                aria-expanded={sessionMenuOpen}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 5h16M4 12h16M4 19h16" />
                </svg>
                <span>{t("topbar.sessionMenu")}</span>
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><polyline points="2 4 5 7 8 4" /></svg>
              </button>
              {sessionMenuOpen && sessionMenuPos && typeof document !== "undefined" && createPortal(
                <div ref={sessionMenuPanelRef} className={s.sessionMenu} style={{ top: sessionMenuPos.top, right: sessionMenuPos.right }} role="menu">
                  <button type="button" className={s.sessionMenuItem} role="menuitem" onClick={() => { setAnalyticsOpen(true); setSessionMenuOpen(false); }}>
                    <span>{t("topbar.analytics")}</span><small>{t("topbar.analyticsTitle")}</small>
                  </button>
                  <button type="button" className={s.sessionMenuItem} role="menuitem" onClick={() => { actions.toggleTopPanel("branches"); setSessionMenuOpen(false); }}>
                    <span>{t("topbar.branches")}</span><small>{state.branchTree.length > 0 ? t("topbar.sessionMenuBranchesHint") : t("topbar.sessionMenuNoBranches")}</small>
                  </button>
                  <button type="button" className={s.sessionMenuItem} role="menuitem" onClick={() => { actions.toggleTopPanel("system"); setSessionMenuOpen(false); }}>
                    <span>{t("topbar.system")}</span><small>{state.systemPrompt ? t("topbar.sessionMenuSystemLoaded") : t("topbar.sessionMenuSystemPending")}</small>
                  </button>
                  <div className={s.sessionMenuDivider} />
                  <button type="button" className={s.sessionMenuItem} role="menuitem" disabled={!state.selectedSession} onClick={() => { handleExportSession(); setSessionMenuOpen(false); }}>
                    <span>HTML</span><small>{t("topbar.exportHtmlHint")}</small>
                  </button>
                  <button type="button" className={s.sessionMenuItem} role="menuitem" disabled={!state.selectedSession} onClick={() => { handleExportMarkdown(); setSessionMenuOpen(false); }}>
                    <span>Markdown</span><small>{t("topbar.exportMdHint")}</small>
                  </button>
                </div>,
                document.body,
              )}
            </div>
          )}
          {showChat && (
            <div className={`${s.chatActions} ${mobileActionsOpen ? s.chatActionsMobileOpen : ""}`}>
              <div className={s.exportMenuWrapper} ref={exportMenuRef}>
                <button
                  onClick={() => setExportMenuOpen((v) => !v)}
                  disabled={!state.selectedSession}
                  title={state.selectedSession ? t("topbar.exportTitle") : t("topbar.exportDisabled")}
                  aria-label={t("topbar.exportTitle")}
                  aria-haspopup="menu"
                  aria-expanded={exportMenuOpen}
                  className={`${s.exportButton} ${state.selectedSession ? s.exportButtonEnabled : s.exportButtonDisabled}`}
                >
                  <span
                    className={s.exportIcon}
                    style={{ color: state.selectedSession ? "var(--text-muted)" : "var(--text-dim)" }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </span>
                  <span>{t("topbar.export")}</span>
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <polyline points="2 4 5 7 8 4" />
                  </svg>
                </button>
                {exportMenuOpen && state.selectedSession && exportMenuPos && typeof document !== "undefined" && createPortal(
                  <div
                    ref={exportMenuPanelRef}
                    className={s.exportMenu}
                    style={{ top: exportMenuPos.top, right: exportMenuPos.right }}
                    role="menu"
                  >
                    <button
                      onClick={() => { handleExportSession(); setExportMenuOpen(false); }}
                      className={s.exportMenuItem}
                      role="menuitem"
                    >
                      <strong>HTML</strong>
                      <span className={s.exportMenuHint}>{t("topbar.exportHtmlHint")}</span>
                    </button>
                    <button
                      onClick={() => { handleExportMarkdown(); setExportMenuOpen(false); }}
                      className={s.exportMenuItem}
                      role="menuitem"
                    >
                      <strong>Markdown</strong>
                      <span className={s.exportMenuHint}>{t("topbar.exportMdHint")}</span>
                    </button>
                  </div>,
                  document.body,
                )}
              </div>
              <button
                onClick={() => { setAnalyticsOpen(true); setMobileActionsOpen(false); }}
                className={`${s.systemButton} ${s.systemButtonDefault} hover-text`}
                title={t("topbar.analyticsTitle")}
                aria-label={t("topbar.analyticsTitle")}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                  <line x1="18" y1="20" x2="18" y2="10" />
                  <line x1="12" y1="20" x2="12" y2="4" />
                  <line x1="6" y1="20" x2="6" y2="14" />
                </svg>
                <span>{t("topbar.analytics")}</span>
              </button>
              <BranchNavigator
                tree={state.branchTree}
                activeLeafId={state.branchActiveLeafId}
                onLeafChange={handleBranchLeafChange}
                inline
                containerRef={topBarRef}
                open={state.activeTopPanel === "branches"}
                onToggle={() => actions.toggleTopPanel("branches")}
                hasSession
                hideTrigger
              />
              <button
                onClick={() => { actions.toggleTopPanel("system"); setMobileActionsOpen(false); }}
                className={`${s.systemButton} ${state.activeTopPanel === "system" ? s.systemButtonActive : s.systemButtonDefault} hover-text`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: state.systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="13" y2="17" />
                </svg>
                <span>{t("topbar.system")}</span>
              </button>
            </div>
          )}
          {/* Session stats — right-aligned in top bar */}
          {showChat && (state.sessionStats || state.contextUsage) && (() => {
            const tokens = state.sessionStats?.tokens;
            const cost = state.sessionStats?.cost ?? 0;
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const costStr = cost > 0 ? (cost >= 0.01 ? `$${cost.toFixed(2)}` : `<$0.01`) : null;

            let ctxColor = "var(--text-muted)";
            let ctxPercentStr: string | null = null;
            let ctxWindowStr: string | null = null;
            if (state.contextUsage?.contextWindow) {
              const pct = state.contextUsage.percent;
              if (pct !== null && pct > 90) ctxColor = "var(--color-error)";
              else if (pct !== null && pct > 70) ctxColor = "var(--color-warning-text-strong)";
              ctxPercentStr = pct !== null ? `${pct.toFixed(0)}%` : "?";
              ctxWindowStr = `/ ${fmt(state.contextUsage.contextWindow)}`;
            }

            const totalTokens = tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite : 0;

            const tooltipParts: string[] = [];
            if (tokens) {
              tooltipParts.push(`in: ${tokens.input.toLocaleString()}`);
              tooltipParts.push(`out: ${tokens.output.toLocaleString()}`);
              tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString()}`);
              tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString()}`);
              if (cost > 0) tooltipParts.push(`cost: $${cost.toFixed(4)}`);
            }
            if (state.contextUsage?.contextWindow) {
              const pct = state.contextUsage.percent;
              tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${state.contextUsage.contextWindow.toLocaleString()} tokens`);
            }
            const tooltip = tooltipParts.join("  |  ");

            return (
              <button
                type="button"
                onClick={() => setAnalyticsOpen(true)}
                title={tooltip}
                className={s.sessionStats}
                aria-label={t("topbar.analyticsTitle")}
                data-testid="session-usage-summary"
              >
                {ctxPercentStr && (
                  <span className={s.contextStat} style={{ color: ctxColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    <span>{ctxPercentStr}</span>
                    <span className={s.contextWindow}>{ctxWindowStr}</span>
                  </span>
                )}
                {costStr && <span className={s.costStat}>{costStr}</span>}
                {!ctxPercentStr && !costStr && totalTokens > 0 && (
                  <span className={s.tokenTotal}>{fmt(totalTokens)} tokens</span>
                )}
              </button>
            );
          })()}
          <button
            type="button"
            onClick={() => setRightPanelOpen((open) => !open)}
            title={rightPanelOpen ? t("topbar.hideFilePanel") : t("topbar.showFilePanel")}
            aria-label={rightPanelOpen ? t("topbar.hideFilePanel") : t("topbar.showFilePanel")}
            className={`${s.topBarButton} ${s.filePanelToggle} ${rightPanelOpen ? s.filePanelToggleOpen : ""} hover-text`}
            style={{ color: rightPanelOpen ? "var(--text)" : "var(--text-muted)" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
          {/* Top panel dropdown — shared, only one active at a time */}
          {state.activeTopPanel && state.topPanelPos && (
            <div
              className={s.topPanelDropdown}
              style={{
                top: state.topPanelPos.top,
                left: state.topPanelPos.left,
                width: state.topPanelPos.width,
              }}
            >
              {state.activeTopPanel === "system" && (
                <div className={s.systemPanel}>
                  {state.systemPrompt ? (
                    <div className={s.systemPromptContent}>
                      {state.systemPrompt}
                    </div>
                  ) : state.systemPrompt === "" ? (
                    <div className={s.systemPromptPlaceholder}>
                      {t("system.empty")}
                    </div>
                  ) : (
                    <div className={s.systemPromptPlaceholder}>
                      {t("system.notLoaded")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Chat content */}
        <div className={s.chatContent}>
          {state.parallelSessions.length > 0 && (state.selectedSession || effectiveNewSessionCwd) ? (
            <div className={s.parallelContainer}>
              <div className={s.parallelPane}>
                {showChat && (
                  <ChatWindow
                    key={`main-${state.sessionKey}`}
                    wideChat={wideChat}
                    session={state.selectedSession}
                    newSessionCwd={effectiveNewSessionCwd}
                    onAgentEnd={actions.handleAgentEnd}
                    onSessionCreated={actions.handleSessionCreated}
                    onSessionForked={actions.handleSessionForked}
                    modelsRefreshKey={modelsRefreshKey}
                    chatInputRef={chatInputRef}
                    onBranchDataChange={handleBranchDataChange}
                    onSystemPromptChange={actions.setSystemPrompt}
                    onSessionStatsChange={actions.setSessionStats}
                    onContextUsageChange={actions.setContextUsage}
                    onSessionNamed={actions.bumpRefreshKey}
                    onOpenModels={() => setModelsConfigOpen(true)}
                    isParallel
                    paneLabel={state.selectedSession ? getSessionDisplayTitle(state.selectedSession) : undefined}
                  />
                )}
              </div>
              {state.parallelSessions.map((session, idx) => (
                <div key={session.id} className={s.parallelPane}>
                  <ChatWindow
                    key={`parallel-${session.id}-${idx}`}
                    wideChat={wideChat}
                    session={session}
                    newSessionCwd={null}
                    modelsRefreshKey={modelsRefreshKey}
                    onAgentEnd={actions.handleAgentEnd}
                    onSessionCreated={actions.handleSessionCreated}
                    onSessionForked={actions.handleSessionForked}
                    onSessionNamed={actions.bumpRefreshKey}
                    onOpenModels={() => setModelsConfigOpen(true)}
                    isParallel
                    paneLabel={getSessionDisplayTitle(session)}
                    onClosePane={state.parallelActiveId === session.id || state.parallelSessions.length > 1
                      ? () => actions.closeParallel(session.id)
                      : undefined}
                  />
                </div>
              ))}
            </div>
          ) : showChat ? (
            <ChatWindow
              key={state.sessionKey}
              wideChat={wideChat}
              session={state.selectedSession}
              newSessionCwd={effectiveNewSessionCwd}
              onAgentEnd={actions.handleAgentEnd}
              onSessionCreated={actions.handleSessionCreated}
              onSessionForked={actions.handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={actions.setSystemPrompt}
              onSessionStatsChange={actions.setSessionStats}
              onContextUsageChange={actions.setContextUsage}
              onSessionNamed={actions.bumpRefreshKey}
              onOpenModels={() => setModelsConfigOpen(true)}
            />
          ) : centerView === "project" ? (
              <div className={s.placeholderContainer}>
                <div className={s.placeholderIconBg}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={s.placeholderIcon}>
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <div className={s.placeholderText}>
                  <div className={s.placeholderTitle}>{t("welcome.selectSession")}</div>
                  <div className={s.placeholderSubtitle}>
                    {t("welcome.chooseFromSidebar")}
                  </div>
                </div>
              </div>
          ) : centerView === "welcome" ? (
              <div className={s.welcomeContainer}>
                <div className={s.welcomeIconBg}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    <line x1="9" y1="10" x2="15" y2="10" />
                  </svg>
                </div>
                <div className={s.placeholderText}>
                  <div className={s.welcomeTitle}>
                    <span className={s.piSymbol}>π</span>
                    <span className={s.titleText}>with tGD</span>
                  </div>
                  <div className={s.welcomeSubtitle}>
                    {t("welcome.subtitle")}
                  </div>
                </div>
                <div className={s.welcomeSteps}>
                  <div className={s.welcomeStep}>
                    <span className={s.welcomeStepNumber}>1</span>
                    <span className={s.welcomeStepText}>{t("welcome.step1")}</span>
                  </div>
                  <div className={s.welcomeStep}>
                    <span className={s.welcomeStepNumber}>2</span>
                    <span className={s.welcomeStepText}>{t("welcome.step2pre")} <strong style={{ color: "var(--text)" }}>+ {t("sidebar.new")}</strong> {t("welcome.step2post")}</span>
                  </div>
                  <div className={s.welcomeStep}>
                    <span className={s.welcomeStepNumber}>3</span>
                    <span className={s.welcomeStepText}>{t("welcome.step3pre")} <strong style={{ color: "var(--text)" }}>{t("sidebar.models")}</strong> {t("welcome.step3post")}</span>
                  </div>
                </div>
              </div>
          ) : null}
        </div>
      </div>

      {/* Right panel: file viewer — always mounted, width animated via CSS.
          The splitter on its left edge drags the width (persisted);
          double-click resets to the 42% default. */}
      <div
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${draggingRight ? " right-panel-dragging" : ""} ${s.rightPanelContainer}`}
        style={rightWidth ? ({ "--right-panel-w": `${rightWidth}px` } as React.CSSProperties) : undefined}
      >
        {rightPanelOpen && (
          <div
            className={`right-panel-resizer${draggingRight ? " right-panel-resizer-active" : ""}`}
            onMouseDown={startRightResize}
            onDoubleClick={resetRightWidth}
            title="Drag to resize · double-click to reset"
            aria-label="Resize file panel"
            role="separator"
            aria-orientation="vertical"
          />
        )}
        {/* Right panel tab bar */}
        <div className={s.rightPanelTabBar} data-testid="right-panel-tab-bar">
          <div className={s.rightPanelTabBarInner}>
            <TabBar
              tabs={fileTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={setActiveFileTabId}
              onCloseTab={handleCloseFileTab}
              onCloseOthers={handleCloseOthers}
              onCloseAll={handleCloseAll}
              onReorder={handleReorderTabs}
              onReveal={revealInExplorer}
            />
          </div>
          <button
            type="button"
            onClick={() => setRightPanelOpen(false)}
            title={t("topbar.hideFilePanel")}
            aria-label={t("topbar.hideFilePanel")}
            className={`${s.mobileFilePanelClose} hover-text`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </div>

        {/* File content */}
        <div className={s.rightPanelContent}>
          {diffFile && panelCwd ? (
            <DiffPanel cwd={panelCwd} path={diffFile} onClose={() => setDiffFile(null)} />
          ) : activeFileTab?.filePath ? (
            <FileViewer filePath={activeFileTab.filePath} cwd={state.activeCwd ?? undefined} gotoLine={activeFileTab.gotoLine} gotoNonce={activeFileTab.gotoNonce} />
          ) : (
            <div className={s.rightPanelEmpty}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <div className={s.rightPanelEmptyTitle}>{t("rightPanel.noFile")}</div>
              <div className={s.rightPanelEmptyHint}>
                {t("rightPanel.noFileHint")}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    {modelsConfigOpen && <Suspense fallback={null}><ModelsConfig onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} /></Suspense>}
    {promptsConfigOpen && (
      <Suspense fallback={null}><PromptsConfig onClose={() => setPromptsConfigOpen(false)} /></Suspense>
    )}
    {skillsConfigOpen && (state.activeCwd ?? state.selectedSession?.cwd ?? state.newSessionCwd) && (
      <Suspense fallback={null}><SkillsConfig cwd={(state.activeCwd ?? state.selectedSession?.cwd ?? state.newSessionCwd)!} onClose={() => setSkillsConfigOpen(false)} /></Suspense>
    )}
    {extensionsConfigOpen && (
      <Suspense fallback={null}><ExtensionsConfig
        sessionId={state.selectedSession?.id ?? null}
        onClose={() => setExtensionsConfigOpen(false)}
        onReload={() => setModelsRefreshKey((key) => key + 1)}
      /></Suspense>
    )}
    {analyticsOpen && <Suspense fallback={null}><AnalyticsModal open={analyticsOpen} onClose={() => setAnalyticsOpen(false)} /></Suspense>}
    {appearanceOpen && <AppearancePanel onClose={() => setAppearanceOpen(false)} />}
    {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    {/* Toast notifications — mount once at app root */}
    <ToastContainer />
    </>
  );
}

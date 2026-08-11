"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { SessionSidebar } from "../sidebar/SessionSidebar";
import { ChatWindow } from "../chat/ChatWindow";
import { ContextInspector } from "../chat/ContextInspector";
import { FileViewer } from "./FileViewer";
import { FilesPanel } from "./FilesPanel";
import { SearchPanel } from "./SearchPanel";
import { ChangesPanel } from "./ChangesPanel";
import { TgdArtifactsPanel } from "./TgdArtifactsPanel";
import { AgentDashboardPanel } from "./AgentDashboardPanel";
import { SchedulePanel } from "./SchedulePanel";
import { AttentionPanel } from "./AttentionPanel";
import { DiffPanel } from "./DiffPanel";
import type { DiffAnnotation } from "./DiffView";
import { DesignInspector } from "./DesignInspector";
import { AppearancePanel } from "./AppearancePanel";
import { IconRail, type PanelView } from "./IconRail";
import { MobileNavigation } from "./MobileNavigation";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { TabBar } from "./TabBar";
import { BranchNavigator, hasSessionBranches } from "../chat/BranchNavigator";
import { useTheme } from "@/hooks/useTheme";
import { useAppShellState } from "@/hooks/useAppShellState";
import { useFileTabs } from "@/hooks/useFileTabs";
import { useRightPanelWidth } from "@/hooks/useRightPanelWidth";
import { useSessions } from "@/hooks/useSessions";
import { useTags } from "@/hooks/useTags";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useToast, showToast } from "@/hooks/useToast";
import { useAttentionCenter } from "@/hooks/useAttentionCenter";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { onOpenFileRequest } from "@/lib/file-links";
import { useI18n, translate } from "@/lib/i18n";
import { toggleAlwaysFollow } from "@/lib/prefs";
import { useTabTitle } from "@/lib/attention";
import { setSkin } from "@/lib/skin";
import { setUiStyle } from "@/lib/ui-style";
import { resolveAppShellCenterView } from "./app-shell-view";
import { ErrorBoundary } from "./ErrorBoundary";
import { resolveWorkspaceIdentity, type WorkspaceIdentity } from "@/lib/workspace-identity";
import { requestOpenProjectSwitcher } from "@/lib/project-switcher-events";
import type { Worktree } from "@/lib/worktrees";
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
const SessionImportDialog = lazy(() => import("../modals/SessionImportDialog").then((m) => ({ default: m.SessionImportDialog })));

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
  const attention = useAttentionCenter();
  const { fileTabs, activeFileTabId, splitFileTabId, rightPanelOpen, setRightPanelOpen, setActiveFileTabId, handleOpenFile: openFileTab, handleCloseFileTab, handleCloseOthers, handleCloseAll, handleReorderTabs, handleTogglePin, handleOpenSplit } = useFileTabs();

  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [extensionsConfigOpen, setExtensionsConfigOpen] = useState(false);
  const [promptsConfigOpen, setPromptsConfigOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [sessionImportOpen, setSessionImportOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarOpenRef = useRef(sidebarOpen);
  const autoCollapsedSidebarRef = useRef(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [designModeOpen, setDesignModeOpen] = useState(false);
  const [panelView, setPanelView] = useState<PanelView>("sessions");
  const [searchFocusSignal, setSearchFocusSignal] = useState(0);
  const [revealSignal, setRevealSignal] = useState(0);
  const [pendingReviewFiles, setPendingReviewFiles] = useState<string[]>([]);
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

  const workspaceCwd = state.selectedSession?.cwd ?? state.newSessionCwd ?? state.activeCwd;
  const [workspaceIdentity, setWorkspaceIdentity] = useState<WorkspaceIdentity | null>(null);
  const fallbackWorkspaceIdentity = workspaceCwd
    ? resolveWorkspaceIdentity(workspaceCwd, [])
    : null;
  const visibleWorkspaceIdentity = workspaceIdentity?.sourceCwd === workspaceCwd
    ? workspaceIdentity
    : fallbackWorkspaceIdentity;

  useEffect(() => {
    if (!workspaceCwd) {
      setWorkspaceIdentity(null);
      return;
    }

    const controller = new AbortController();
    fetch(`/api/worktrees?cwd=${encodeURIComponent(workspaceCwd)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { worktrees?: Worktree[] } | null) => {
        if (!controller.signal.aborted) {
          setWorkspaceIdentity(resolveWorkspaceIdentity(workspaceCwd, data?.worktrees ?? []));
        }
      })
      .catch(() => {
        // The cwd label remains useful outside git or during a transient fetch failure.
      });
    return () => controller.abort();
  }, [workspaceCwd]);

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

  useEffect(() => {
    sidebarOpenRef.current = sidebarOpen;
  }, [sidebarOpen]);

  /* Three simultaneous panes leave the transcript too narrow on ordinary
     laptops. Opening a file therefore borrows the contextual panel's width
     below 1600px, and restores it when the file viewer closes. */
  useEffect(() => {
    if (rightPanelOpen && window.innerWidth < 1600 && sidebarOpenRef.current) {
      autoCollapsedSidebarRef.current = true;
      setSidebarOpen(false);
      return;
    }
    if (!rightPanelOpen && autoCollapsedSidebarRef.current) {
      autoCollapsedSidebarRef.current = false;
      setSidebarOpen(true);
    }
  }, [rightPanelOpen]);

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

  const handleOpenProjectSwitcher = useCallback(() => {
    setPanelView("sessions");
    window.setTimeout(requestOpenProjectSwitcher, 0);
  }, []);

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
  const effectiveCwdForPalette = state.selectedSession?.cwd ?? state.newSessionCwd ?? state.activeCwd;

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
      setUiStyle,
      newSession: () => {
        if (!effectiveCwdForPalette) return;
        const tempId = typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
        handleNewSessionFromSidebar(tempId, effectiveCwdForPalette);
      },
      importSession: () => {
        if (state.selectedSession) setSessionImportOpen(true);
        else showToast(translate("sessionImport.openSessionFirst"), { type: "warning" });
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

  const handleCompareSessions = useCallback(async (sessionIds: string[]) => {
    const sessions = await Promise.all(sessionIds.map(async (sessionId) => {
      const known = allSessions.find((session) => session.id === sessionId);
      if (known) return known;
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
        if (!response.ok) return null;
        const payload = await response.json() as { info?: SessionInfo | null };
        return payload.info ?? null;
      } catch {
        return null;
      }
    }));
    const usable = sessions.filter((session): session is SessionInfo => Boolean(session));
    if (usable.length < 2) {
      showToast(t("extensionUI.noSession"), { type: "warning" });
      return;
    }
    handleSelectSessionFromSidebar(usable[0]);
    usable.slice(1, 3).forEach((session) => actions.openParallel(session));
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

  const handleDesignCapture = useCallback((context: string) => {
    chatInputRef.current?.insertText(context);
    setDesignModeOpen(false);
    setMobileActionsOpen(false);
    showToast(t("topbar.designCaptured"), { type: "success" });
  }, [t]);

  const handleDiffAnnotation = useCallback((annotation: DiffAnnotation & { path: string }) => {
    const kind = annotation.type === "added" ? "added" : annotation.type === "removed" ? "removed" : "unchanged";
    const prompt = [
      `Review ${annotation.path}:${annotation.lineNo} (${kind} line).`,
      `Line: ${annotation.text || "(blank)"}`,
      `Requested change: ${annotation.comment}`,
    ].join("\n");
    chatInputRef.current?.insertText(prompt);
    showToast(t("diff.annotationAdded"), { type: "success" });
  }, [t]);

  const handleFileAgentPrompt = useCallback((prompt: string) => {
    if (!state.selectedSession) {
      showToast(t("extensionUI.noSession"), { type: "warning" });
      return;
    }
    chatInputRef.current?.insertText(prompt);
    showToast("Added file context to the composer", { type: "success" });
  }, [state.selectedSession, t]);

  const handleAgentEndWithReview = useCallback(() => {
    actions.handleAgentEnd();
    const cwd = state.selectedSession?.cwd ?? state.activeCwd;
    if (!cwd) return;
    window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/git/changes?cwd=${encodeURIComponent(cwd)}`);
        if (!response.ok) return;
        const payload = await response.json() as { files?: Array<{ path: string }> };
        const paths = (payload.files ?? []).map((file) => file.path);
        setPendingReviewFiles(paths);
        if (paths.length === 0) return;
        const first = paths[0];
        const absolute = `${cwd.replace(/[\\/]$/, "")}/${first}`;
        openFileTab(absolute, first.split(/[\\/]/).pop() ?? first);
        showToast(`${paths.length} changed file${paths.length === 1 ? "" : "s"} ready to review`, { type: "success" });
      } catch { /* changes are optional outside git workspaces */ }
    }, 450);
  }, [actions, openFileTab, state.activeCwd, state.selectedSession?.cwd]);

  const handleExportSession = useCallback(() => {
    if (!state.selectedSession) return;
    window.location.href = `/api/sessions/${encodeURIComponent(state.selectedSession.id)}/export`;
  }, [state.selectedSession]);

  const handleExportMarkdown = useCallback(() => {
    if (!state.selectedSession) return;
    window.location.href = `/api/sessions/${encodeURIComponent(state.selectedSession.id)}/export-md`;
  }, [state.selectedSession]);

  const handleCloneSession = useCallback(async () => {
    const selected = state.selectedSession;
    if (!selected) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(selected.id)}/clone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const payload = await response.json() as { sessionId?: string; sessionFile?: string; cwd?: string; error?: string };
      if (!response.ok || !payload.sessionId) throw new Error(payload.error ?? `HTTP ${response.status}`);
      actions.handleSessionForked(payload.sessionId, payload.cwd ?? selected.cwd, payload.sessionFile);
      showToast(t("session.cloned"), { type: "success" });
    } catch (error) { showToast(`${t("session.cloneFailed")}: ${error instanceof Error ? error.message : error}`, { type: "error" }); }
  }, [actions, state.selectedSession, t]);

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
      const desiredRight = window.innerWidth - rect.right;
      // The mobile action strip places Export in the left column. Aligning a
      // fixed-width menu to that button's right edge can push the menu past
      // the viewport's left edge, so clamp both horizontal gutters.
      const menuWidth = Math.min(248, Math.max(0, window.innerWidth - 16));
      const maxRight = Math.max(8, window.innerWidth - menuWidth - 8);
      setExportMenuPos({ top: rect.bottom + 4, right: Math.max(8, Math.min(desiredRight, maxRight)) });
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
  const splitFileTab = fileTabs.find((t) => t.id === splitFileTabId && t.id !== activeFileTabId) ?? null;

  useEffect(() => {
    if (!activeFileTab?.filePath || pendingReviewFiles.length === 0) return;
    const cwd = state.selectedSession?.cwd ?? state.activeCwd;
    if (!cwd) return;
    const relative = activeFileTab.filePath.startsWith(`${cwd}/`) ? activeFileTab.filePath.slice(cwd.length + 1) : activeFileTab.filePath;
    setPendingReviewFiles((current) => current.filter((path) => path !== relative));
  }, [activeFileTab?.filePath, pendingReviewFiles.length, state.activeCwd, state.selectedSession?.cwd]);

  const openNextReviewFile = useCallback(() => {
    const cwd = state.selectedSession?.cwd ?? state.activeCwd;
    const next = pendingReviewFiles[0];
    if (!cwd || !next) return;
    openFileTab(`${cwd.replace(/[\\/]$/, "")}/${next}`, next.split(/[\\/]/).pop() ?? next);
  }, [openFileTab, pendingReviewFiles, state.activeCwd, state.selectedSession?.cwd]);

  const panelCwd = state.selectedSession?.cwd ?? state.newSessionCwd ?? state.activeCwd ?? null;

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
      ) : panelView === "attention" ? (
        <AttentionPanel
          items={attention.items}
          readIds={attention.readIds}
          loading={attention.loading}
          error={attention.error}
          onRefresh={() => void attention.refresh()}
          onMarkRead={attention.markItemRead}
          onMarkAllRead={attention.markAllRead}
          onOpenSession={handleOpenScheduledSession}
          onOpenSource={(source) => {
            setPanelView(source === "agent" ? "agents" : "schedule");
            setSidebarOpen(true);
          }}
        />
      ) : panelView === "agents" ? (
        <AgentDashboardPanel
          defaultCwd={panelCwd}
          onOpenSession={handleOpenScheduledSession}
          onCompareSessions={handleCompareSessions}
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
  const sessionHasBranches = hasSessionBranches(state.branchTree);
  const systemPromptUnavailable = state.systemPrompt === null;
  const systemPanelStyle = state.topPanelPos && typeof window !== "undefined"
    ? (() => {
        const margin = 8;
        const width = Math.min(760, state.topPanelPos.width - margin * 2);
        return {
          top: state.topPanelPos.top + 6,
          left: Math.max(
            margin,
            state.topPanelPos.left + state.topPanelPos.width - width - margin,
          ),
          width,
        };
      })()
    : null;
  const blockingDialogOpen = modelsConfigOpen
    || skillsConfigOpen
    || extensionsConfigOpen
    || promptsConfigOpen
    || analyticsOpen
    || sessionImportOpen
    || appearanceOpen
    || shortcutsOpen;

  return (
    <>
    <title>{tabTitle}</title>
    <div
      className={s.container}
      data-testid="app-shell"
      inert={blockingDialogOpen}
      aria-hidden={blockingDialogOpen || undefined}
    >
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
        attentionUnreadCount={attention.unreadCount}
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
        onOpenDesignMode={() => setDesignModeOpen(true)}
        attentionUnreadCount={attention.unreadCount}
      />
      {/* Mobile overlay backdrop */}
      <div
        className={`${s.sidebarOverlay} sidebar-overlay-backdrop`}
        onClick={() => setSidebarOpen(false)}
        style={{
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
        }}
      />

      {/* Left sidebar */}
      <div
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"} ${s.sidebarContainer}`}
        data-panel-view={panelView}
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen}
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
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <div className={s.sessionIdentity} data-testid="session-identity">
            {visibleWorkspaceIdentity && (
              <button
                type="button"
                className={s.workspaceIdentity}
                aria-label={`${t("cwd.select")} · ${t("topbar.repository")}: ${visibleWorkspaceIdentity.repository}${visibleWorkspaceIdentity.branch ? `, ${t("topbar.branch")}: ${visibleWorkspaceIdentity.branch}` : ""}`}
                title={visibleWorkspaceIdentity.root}
                onClick={handleOpenProjectSwitcher}
              >
                <span className={s.workspaceRepository} data-testid="workspace-repository">
                  {visibleWorkspaceIdentity.repository}
                </span>
                <span
                  className={`${s.workspaceBranch} ${visibleWorkspaceIdentity.isGit ? "" : s.workspaceBranchNeutral}`}
                  data-testid="workspace-branch"
                  title={visibleWorkspaceIdentity.detached && visibleWorkspaceIdentity.branch
                    ? `${t("topbar.detached")} · ${visibleWorkspaceIdentity.branch}`
                    : visibleWorkspaceIdentity.branch ?? t("topbar.notGitRepository")}
                >
                  {visibleWorkspaceIdentity.detached && visibleWorkspaceIdentity.branch
                    ? <>{visibleWorkspaceIdentity.branch}<span className={s.detachedLabel}> · {t("topbar.detached")}</span></>
                    : visibleWorkspaceIdentity.branch
                    ?? (workspaceIdentity?.sourceCwd === workspaceCwd ? t("topbar.notGitRepository") : "…")}
                </span>
              </button>
            )}
            <div className={s.chatTitle} title={state.selectedSession ? getSessionDisplayTitle(state.selectedSession, 240) : undefined}>
              {state.selectedSession
                ? getSessionDisplayTitle(state.selectedSession)
                : effectiveNewSessionCwd
                  ? t("sidebar.new").toLowerCase()
                  : "π"}
            </div>
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
                  <button
                    type="button"
                    className={`${s.sessionMenuItem} ${designModeOpen ? s.sessionMenuItemActive : ""}`}
                    role="menuitem"
                    onClick={() => { setDesignModeOpen((open) => !open); setSessionMenuOpen(false); }}
                  >
                    <span>{t("topbar.designMode")}</span><small>{t("topbar.designModeHint")}</small>
                  </button>
                  <button
                    type="button"
                    className={s.sessionMenuItem}
                    role="menuitem"
                    disabled={!sessionHasBranches}
                    onClick={() => {
                      if (sessionHasBranches) actions.toggleTopPanel("branches");
                      setSessionMenuOpen(false);
                    }}
                  >
                    <span>{t("topbar.branches")}</span><small>{sessionHasBranches ? t("topbar.sessionMenuBranchesHint") : t("topbar.sessionMenuNoBranches")}</small>
                  </button>
                  <button
                    type="button"
                    className={s.sessionMenuItem}
                    role="menuitem"
                    disabled={systemPromptUnavailable}
                    onClick={() => {
                      if (!systemPromptUnavailable) actions.toggleTopPanel("system");
                      setSessionMenuOpen(false);
                    }}
                  >
                    <span>{t("topbar.system")}</span>
                    <small>{systemPromptUnavailable
                      ? t("topbar.sessionMenuSystemUnavailable")
                      : state.systemPrompt
                        ? t("topbar.sessionMenuSystemLoaded")
                        : t("topbar.sessionMenuSystemEmpty")}
                    </small>
                  </button>
                  <div className={s.sessionMenuDivider} />
                  <button type="button" className={s.sessionMenuItem} role="menuitem" disabled={!state.selectedSession} onClick={() => { void handleCloneSession(); setSessionMenuOpen(false); }}>
                    <span>{t("session.clone")}</span><small>{t("session.cloneHint")}</small>
                  </button>
                  <button type="button" className={s.sessionMenuItem} role="menuitem" disabled={!state.selectedSession} onClick={() => { handleExportSession(); setSessionMenuOpen(false); }}>
                    <span>{t("topbar.exportHtmlLabel")}</span><small>{t("topbar.exportHtmlHint")}</small>
                  </button>
                  <button type="button" className={s.sessionMenuItem} role="menuitem" disabled={!state.selectedSession} onClick={() => { handleExportMarkdown(); setSessionMenuOpen(false); }}>
                    <span>{t("topbar.exportMdLabel")}</span><small>{t("topbar.exportMdHint")}</small>
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
                      <strong>{t("topbar.exportHtmlLabel")}</strong>
                      <span className={s.exportMenuHint}>{t("topbar.exportHtmlHint")}</span>
                    </button>
                    <button
                      onClick={() => { handleExportMarkdown(); setExportMenuOpen(false); }}
                      className={s.exportMenuItem}
                      role="menuitem"
                    >
                      <strong>{t("topbar.exportMdLabel")}</strong>
                      <span className={s.exportMenuHint}>{t("topbar.exportMdHint")}</span>
                    </button>
                    <button onClick={() => { void handleCloneSession(); setExportMenuOpen(false); setMobileActionsOpen(false); }} className={s.exportMenuItem} role="menuitem">
                      <strong>{t("session.clone")}</strong>
                      <span className={s.exportMenuHint}>{t("session.cloneHint")}</span>
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
                disabled={systemPromptUnavailable}
                title={systemPromptUnavailable ? t("topbar.sessionMenuSystemUnavailable") : t("topbar.system")}
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
        </div>

        {/* Portalled to body because the top bar's backdrop-filter creates a
            stacking context that would otherwise let chat messages paint over
            this fixed panel. */}
        {state.activeTopPanel === "system" && systemPanelStyle && typeof document !== "undefined" && createPortal(
          <section
            className={s.topPanelDropdown}
            style={systemPanelStyle}
            role="dialog"
            aria-label={t("topbar.system")}
            data-testid="system-prompt-panel"
          >
            <div className={s.systemPanel}>
              <header className={s.systemPanelHeader}>
                <strong>{t("context.title")}</strong>
                <button
                  type="button"
                  className={s.systemPanelClose}
                  onClick={() => actions.toggleTopPanel("system")}
                  aria-label={t("common.close")}
                  title={t("common.close")}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </header>
              <div className={s.systemPromptContent}>
                <ContextInspector sessionId={state.selectedSession?.id ?? null} fallbackPrompt={state.systemPrompt} />
              </div>
            </div>
          </section>,
          document.body,
        )}

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
                    onAgentEnd={handleAgentEndWithReview}
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
                    onAgentEnd={handleAgentEndWithReview}
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
              onAgentEnd={handleAgentEndWithReview}
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
              onTogglePin={handleTogglePin}
              onOpenSplit={handleOpenSplit}
              splitTabId={splitFileTabId}
            />
          </div>
          {pendingReviewFiles.length > 0 && (
            <button type="button" className={s.reviewQueueButton} onClick={openNextReviewFile} title="Open next changed file">
              {pendingReviewFiles.length} to review
            </button>
          )}
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
            <DiffPanel cwd={panelCwd} path={diffFile} onClose={() => setDiffFile(null)} onAnnotate={handleDiffAnnotation} />
          ) : activeFileTab?.filePath ? (
            <div className={`${s.fileWorkspace} ${splitFileTab ? s.fileWorkspaceSplit : ""}`}>
              <div className={s.fileWorkspacePane}>
                <FileViewer
                  filePath={activeFileTab.filePath}
                  cwd={state.activeCwd ?? undefined}
                  gotoLine={activeFileTab.gotoLine}
                  gotoNonce={activeFileTab.gotoNonce}
                  onSendToAgent={state.selectedSession ? handleFileAgentPrompt : undefined}
                  sessionId={state.selectedSession?.id ?? null}
                />
              </div>
              {splitFileTab && (
                <div className={s.fileWorkspacePane} data-testid="file-split-pane">
                  <FileViewer
                    filePath={splitFileTab.filePath}
                    cwd={state.activeCwd ?? undefined}
                    gotoLine={splitFileTab.gotoLine}
                    gotoNonce={splitFileTab.gotoNonce}
                    onSendToAgent={state.selectedSession ? handleFileAgentPrompt : undefined}
                    sessionId={state.selectedSession?.id ?? null}
                  />
                </div>
              )}
            </div>
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
    {sessionImportOpen && state.selectedSession && (
      <Suspense fallback={null}><SessionImportDialog
        sessionId={state.selectedSession.id}
        onClose={() => setSessionImportOpen(false)}
        onImported={(sessionId, cwd, sessionFile) => {
          setSessionImportOpen(false);
          actions.handleSessionForked(sessionId, cwd, sessionFile);
          showToast(translate("sessionImport.done"), { type: "success" });
        }}
      /></Suspense>
    )}
    {appearanceOpen && <AppearancePanel onClose={() => setAppearanceOpen(false)} />}
    {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    <DesignInspector active={designModeOpen && showChat} onClose={() => setDesignModeOpen(false)} onCapture={handleDesignCapture} />
    {/* Toast notifications — mount once at app root */}
    <ToastContainer />
    </>
  );
}

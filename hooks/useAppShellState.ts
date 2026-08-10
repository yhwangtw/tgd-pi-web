"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";

export interface SessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost?: number;
}

export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface AppShellState {
  // Session/cwd
  selectedSession: SessionInfo | null;
  newSessionCwd: string | null;
  refreshKey: number;
  sessionKey: number;
  explorerRefreshKey: number;
  activeCwd: string | null;
  initialSessionId: string | null;
  initialSessionRestored: boolean;

  // Top panel
  branchTree: SessionTreeNode[];
  branchActiveLeafId: string | null;
  systemPrompt: string | null;
  activeTopPanel: "branches" | "system" | null;
  topPanelPos: { top: number; left: number; width: number } | null;

  // Stats
  sessionStats: SessionStats | null;
  contextUsage: ContextUsage | null;

  // Multi-session parallel view
  parallelSessions: SessionInfo[];
  parallelActiveId: string | null;
}

export interface AppShellActions {
  setBranchTree: (tree: SessionTreeNode[]) => void;
  setBranchActiveLeafId: (id: string | null) => void;
  setSystemPrompt: (s: string | null) => void;
  setSessionStats: (s: SessionStats | null) => void;
  setContextUsage: (u: ContextUsage | null) => void;
  toggleTopPanel: (panel: "branches" | "system") => void;

  // Cwd
  handleCwdChange: (cwd: string | null) => void;
  handleSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  handleNewSession: (sessionId: string, cwd: string) => void;
  handleSessionCreated: (session: SessionInfo) => void;
  handleAgentEnd: () => void;
  handleSessionForked: (newSessionId: string, cwd?: string, sessionFile?: string) => void;
  handleInitialRestoreDone: () => void;
  handleSessionDeleted: (sessionId: string) => void;
  bumpRefreshKey: () => void;

  // Multi-session parallel view
  openParallel: (session: SessionInfo) => void;
  closeParallel: (sessionId: string) => void;
  setActiveParallel: (sessionId: string) => void;
}

export interface AppShellRefs {
  branchLeafChangeFnRef: React.MutableRefObject<((leafId: string | null) => void) | null>;
  suppressCwdBumpRef: React.MutableRefObject<boolean>;
}

export function useAppShellState(): {
  state: AppShellState;
  actions: AppShellActions;
  refs: AppShellRefs;
  topBarRef: React.MutableRefObject<HTMLDivElement | null>;
} {
  const router = useRouter();
  const searchParams = useSearchParams();
  const topBarRef = useRef<HTMLDivElement>(null);

  // Session/cwd state
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const initialSessionId = searchParams.get("session");
  const [initialSessionRestored, setInitialSessionRestored] = useState(false);
  const suppressCwdBumpRef = useRef(false);
  const selectedSessionRef = useRef<SessionInfo | null>(null);
  selectedSessionRef.current = selectedSession;

  // Back/forward navigation can change the URL without remounting AppShell.
  // Keep the restore gate aligned with that live route instead of only reading
  // the initial URL once.
  useEffect(() => {
    if (initialSessionId && selectedSession?.id !== initialSessionId) {
      setInitialSessionRestored(false);
    }
  }, [initialSessionId, selectedSession?.id]);

  // Top panel state
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  // Multi-session parallel view: up to 3 sessions side-by-side. The "main"
  // session is still `selectedSession` (drives URL/router state); the
  // additional ones live here. `parallelActiveId` is the most-recently-focused
  // session in the multi-pane view.
  const [parallelSessions, setParallelSessions] = useState<SessionInfo[]>([]);
  const [parallelActiveId, setParallelActiveId] = useState<string | null>(null);

  // Top panel position tracking
  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const rect = topBarRef.current!.getBoundingClientRect();
      setTopPanelPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel]);

  // Cwd/session handlers
  const handleCwdChange = useCallback(
    (cwd: string | null) => {
      setActiveCwd(cwd);
      if (!cwd || suppressCwdBumpRef.current) return;
      // The sidebar follows the open session's cwd (cross-project selection
      // syncs the picker). That follow-up notification must not reset the
      // view — and especially must not wipe the ?session= URL param that
      // handleSelectSession just wrote.
      if (selectedSessionRef.current?.cwd === cwd) return;
      setSelectedSession((prev) => (prev && prev.cwd !== cwd ? null : prev));
      setNewSessionCwd((prev) => (prev && prev !== cwd ? null : prev));
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    },
    [router],
  );

  const handleSelectSession = useCallback(
    (session: SessionInfo, isRestore = false) => {
      setActiveCwd(session.cwd ?? null);
      setNewSessionCwd(null);
      setSelectedSession(session);
      setSessionKey((k) => k + 1);
      setSystemPrompt(null);
      setInitialSessionRestored(true);
      if (isRestore) {
        suppressCwdBumpRef.current = true;
        setTimeout(() => { suppressCwdBumpRef.current = false; }, 0);
      }
      if (!isRestore) {
        router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
      }
    },
    [router],
  );

  const handleNewSession = useCallback(
    (_sessionId: string, cwd: string) => {
      setActiveCwd(cwd);
      setSelectedSession(null);
      setNewSessionCwd(cwd);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    },
    [router],
  );

  const handleSessionCreated = useCallback(
    (session: SessionInfo) => {
      setActiveCwd(session.cwd ?? null);
      setNewSessionCwd(null);
      setSelectedSession(session);
      if (!session.ephemeral) setRefreshKey((k) => k + 1);
      router.replace(session.ephemeral ? "/" : `?session=${encodeURIComponent(session.id)}`, { scroll: false });
    },
    [router],
  );

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback(
    (newSessionId: string, cwd?: string, sessionFile?: string) => {
      const current = selectedSessionRef.current;
      if (current?.id === newSessionId && (!cwd || current.cwd === cwd) && (!sessionFile || current.path === sessionFile)) {
        return;
      }
      const nextSession: SessionInfo = {
        ...(current ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
        id: newSessionId,
        ...(cwd ? { cwd } : {}),
        ...(sessionFile ? { path: sessionFile } : {}),
      };
      selectedSessionRef.current = nextSession;
      setRefreshKey((k) => k + 1);
      setSessionKey((k) => k + 1);
      setNewSessionCwd(null);
      setSelectedSession(nextSession);
      if (cwd) setActiveCwd(cwd);
      router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
    },
    [router],
  );

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback(
    (sessionId: string) => {
      setRefreshKey((k) => k + 1);
      const selected = selectedSessionRef.current;
      if (selected?.id !== sessionId) return;
      const cwd = selected.cwd;
      setActiveCwd(cwd ?? null);
      setNewSessionCwd(cwd ?? null);
      setSelectedSession(null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    },
    [router],
  );

  const bumpRefreshKey = useCallback(() => setRefreshKey((k) => k + 1), []);

  const openParallel = useCallback((session: SessionInfo) => {
    setParallelSessions((prev) => {
      if (prev.some((s) => s.id === session.id)) return prev;
      // Cap at 2 parallel sessions; main + 2 = 3 total visible
      return [...prev, session].slice(-2);
    });
    setParallelActiveId(session.id);
  }, []);

  const closeParallel = useCallback((sessionId: string) => {
    setParallelSessions((prev) => prev.filter((s) => s.id !== sessionId));
    setParallelActiveId((cur) => (cur === sessionId ? null : cur));
  }, []);

  const setActiveParallel = useCallback((sessionId: string) => {
    setParallelActiveId(sessionId);
  }, []);

  const toggleTopPanel = useCallback((panel: "branches" | "system") => {
    setActiveTopPanel((cur) => (cur === panel ? null : panel));
  }, []);

  return {
    state: {
      selectedSession,
      newSessionCwd,
      refreshKey,
      sessionKey,
      explorerRefreshKey,
      activeCwd,
      initialSessionId,
      initialSessionRestored,
      branchTree,
      branchActiveLeafId,
      systemPrompt,
      activeTopPanel,
      topPanelPos,
      sessionStats,
      contextUsage,
      parallelSessions,
      parallelActiveId,
    },
    actions: {
      setBranchTree,
      setBranchActiveLeafId,
      setSystemPrompt,
      setSessionStats,
      setContextUsage,
      toggleTopPanel,
      handleCwdChange,
      handleSelectSession,
      handleNewSession,
      handleSessionCreated,
      handleAgentEnd,
      handleSessionForked,
      handleInitialRestoreDone,
      handleSessionDeleted,
      bumpRefreshKey,
      openParallel,
      closeParallel,
      setActiveParallel,
    },
    refs: { branchLeafChangeFnRef, suppressCwdBumpRef },
    topBarRef,
  };
}

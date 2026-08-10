"use client";

import { useState, useCallback, useEffect } from "react";
import type { Tab } from "@/components/layout/TabBar";

export function useFileTabs() {
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [splitFileTabId, setSplitFileTabId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const restored = JSON.parse(localStorage.getItem("pi-file-workspace-v1") ?? "null") as { tabs?: Tab[]; active?: string | null; split?: string | null } | null;
      const tabs = restored?.tabs?.filter((tab) => typeof tab?.filePath === "string").slice(0, 30) ?? [];
      setFileTabs(tabs);
      setActiveFileTabId(restored?.active && tabs.some((tab) => tab.id === restored.active) ? restored.active : tabs[0]?.id ?? null);
      setSplitFileTabId(restored?.split && tabs.some((tab) => tab.id === restored.split) ? restored.split : null);
      if (tabs.length > 0) setRightPanelOpen(true);
    } catch { /* start with an empty workspace */ }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem("pi-file-workspace-v1", JSON.stringify({ tabs: fileTabs, active: activeFileTabId, split: splitFileTabId }));
  }, [activeFileTabId, fileTabs, restored, splitFileTabId]);

  const handleOpenFile = useCallback((filePath: string, fileName: string, gotoLine?: number) => {
    const tabId = `file:${filePath}`;
    // Fresh nonce whenever a line is requested, so reopening an already-open
    // file (or the same file at a new line) re-triggers the jump.
    const gotoNonce = gotoLine ? Date.now() : undefined;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (existing) {
        if (!gotoLine) return prev;
        return prev.map((t) => (t.id === tabId ? { ...t, gotoLine, gotoNonce } : t));
      }
      return [...prev, { id: tabId, label: fileName, filePath, gotoLine, gotoNonce }];
    });
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
  }, []);

  const handleCloseFileTab = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) setRightPanelOpen(false);
      return next;
    });
    setSplitFileTabId((current) => current === tabId ? null : current);
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [fileTabs]);

  const handleCloseOthers = useCallback((tabId: string) => {
    setFileTabs((prev) => prev.filter((t) => t.id === tabId));
    setActiveFileTabId(tabId);
  }, []);

  const handleCloseAll = useCallback(() => {
    setFileTabs([]);
    setActiveFileTabId(null);
    setRightPanelOpen(false);
    setSplitFileTabId(null);
  }, []);

  const handleTogglePin = useCallback((tabId: string) => {
    setFileTabs((prev) => prev.map((tab) => tab.id === tabId ? { ...tab, pinned: !tab.pinned } : tab));
  }, []);

  const handleOpenSplit = useCallback((tabId: string) => {
    if (splitFileTabId === tabId) {
      setSplitFileTabId(null);
      return;
    }
    if (activeFileTabId === tabId) {
      const other = fileTabs.find((tab) => tab.id !== tabId);
      if (other) setActiveFileTabId(other.id);
    }
    setSplitFileTabId(tabId);
    setRightPanelOpen(true);
  }, [activeFileTabId, fileTabs, splitFileTabId]);

  const handleReorderTabs = useCallback((tabId: string, toIndex: number) => {
    setFileTabs((prev) => {
      const from = prev.findIndex((t) => t.id === tabId);
      if (from === -1 || from === toIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved);
      return next;
    });
  }, []);

  return {
    fileTabs,
    activeFileTabId,
    splitFileTabId,
    rightPanelOpen,
    setRightPanelOpen,
    setActiveFileTabId,
    handleOpenFile,
    handleCloseFileTab,
    handleCloseOthers,
    handleCloseAll,
    handleReorderTabs,
    handleTogglePin,
    handleOpenSplit,
  };
}

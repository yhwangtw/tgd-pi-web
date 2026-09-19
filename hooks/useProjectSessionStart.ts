"use client";

import { useCallback, useEffect, useRef } from "react";

/** Keeps the New intent attached to an explicit project choice, never a background cwd update. */
export function useProjectSessionStart(
  selectedCwd: string | null,
  selectCwd: (cwd: string) => void,
  showPicker: (open: boolean) => void,
  onNewSession?: (sessionId: string, cwd: string) => void,
) {
  const pendingNew = useRef(false);
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current++; pendingNew.current = false; }, []);

  const createConversation = useCallback((cwd: string) => {
    const id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    // The runtime still starts lazily on the first message, not on New.
    onNewSession?.(id, cwd);
  }, [onNewSession]);

  const openPicker = useCallback((startNewSession = false) => {
    epoch.current++;
    pendingNew.current = startNewSession;
    showPicker(true);
  }, [showPicker]);

  const closePicker = useCallback(() => {
    epoch.current++;
    pendingNew.current = false;
    showPicker(false);
  }, [showPicker]);

  const pickProject = useCallback((cwd: string) => {
    const shouldStart = pendingNew.current;
    closePicker();
    selectCwd(cwd);
    if (shouldStart) createConversation(cwd);
  }, [closePicker, selectCwd, createConversation]);

  const resolveProject = useCallback(async (url: string, body?: { cwd: string }): Promise<string | null> => {
    const requestEpoch = ++epoch.current;
    try {
      const response = await fetch(url, {
        method: "POST",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (requestEpoch !== epoch.current) return null;
      if (!response.ok || data.error) return data.error ?? `HTTP ${response.status}`;
      if (!data.cwd) return "No project directory returned";
      pickProject(data.cwd);
      return null;
    } catch (error) {
      if (requestEpoch !== epoch.current) return null;
      return error instanceof Error ? error.message : String(error);
    }
  }, [pickProject]);

  const pickProjectPath = useCallback((path: string) => resolveProject("/api/cwd/validate", { cwd: path }), [resolveProject]);
  const pickDefaultProject = useCallback(() => resolveProject("/api/default-cwd"), [resolveProject]);
  const startNew = useCallback(() => {
    if (selectedCwd) createConversation(selectedCwd);
    else openPicker(true);
  }, [selectedCwd, createConversation, openPicker]);

  return { startNew, openPicker, closePicker, pickProject, pickProjectPath, pickDefaultProject };
}

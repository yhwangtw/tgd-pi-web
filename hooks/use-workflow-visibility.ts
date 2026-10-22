"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

export type WorkflowKey = "Goal" | "Plan";
type HiddenWorkflows = Partial<Record<WorkflowKey, boolean>>;

function readHidden(scope: string): HiddenWorkflows {
  try {
    const stored = JSON.parse(localStorage.getItem(scope) ?? "{}");
    // Older releases stored a title hash. Preserve that preference without
    // depending on task text, which can change during a replay or refinement.
    return Object.fromEntries((["Goal", "Plan"] as const)
      .filter(key => stored?.[key] === true || typeof stored?.[key] === "string")
      .map(key => [key, true]));
  } catch { return {}; }
}

/** Presentation only: hiding a workflow never pauses, exits or starts it. */
export function useWorkflowVisibility(sessionId?: string) {
  const scope = `pi-workflow-hidden:${sessionId ?? "unsaved"}`;
  const stored = useMemo(() => readHidden(scope), [scope]);
  const [preference, setPreference] = useState(() => ({ scope, hidden: stored }));
  const hidden = preference.scope === scope ? preference.hidden : stored;
  const toolbarRefs = useRef<Partial<Record<WorkflowKey, HTMLButtonElement | null>>>({});
  const cardRefs = useRef<Partial<Record<WorkflowKey, HTMLButtonElement | null>>>({});
  const focusTarget = useRef<{ scope: string; key: WorkflowKey; hide: boolean } | null>(null);
  const id = useId();

  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(scope) ?? "{}");
      if (["Goal", "Plan"].some(key => typeof raw?.[key] === "string")) {
        localStorage.setItem(scope, JSON.stringify(stored));
      }
    } catch { /* Read-only storage still supports the in-memory preference. */ }
  }, [scope, stored]);

  useLayoutEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    if (!target || target.scope !== scope) return;
    (target.hide ? toolbarRefs : cardRefs).current[target.key]?.focus();
  }, [preference, scope]);

  const setHidden = (key: WorkflowKey, hide: boolean, control?: HTMLButtonElement) => {
    // Pointer activation preserves the mobile composer focus; keyboard users
    // follow the card to its toolbar control and back when it is reopened.
    if (control && document.activeElement === control) focusTarget.current = { scope, key, hide };
    const next = { ...hidden, [key]: hide };
    setPreference({ scope, hidden: next });
    try { localStorage.setItem(scope, JSON.stringify(next)); } catch { /* In-memory preference still works. */ }
  };

  return { hidden, setHidden, toolbarRefs, cardRefs, cardId: (key: WorkflowKey) => `${id}-${key}` };
}

export type WorkflowVisibility = ReturnType<typeof useWorkflowVisibility>;

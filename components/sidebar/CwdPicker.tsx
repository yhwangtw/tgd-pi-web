"use client";

import { useCallback, useEffect, type RefObject } from "react";
import { ChevronDown, Folder } from "lucide-react";
import { shortenCwd } from "./session-utils";
import { ProjectSwitcher } from "./ProjectSwitcher";
import styles from "./CwdPicker.module.css";
import { onOpenProjectSwitcher } from "@/lib/project-switcher-events";
import { useI18n } from "@/lib/i18n";

interface CwdPickerState {
  selectedCwd: string | null;
  homeDir: string;
  dropdownOpen: boolean;
  customPathOpen: boolean;
  customPathValue: string;
  customPathError: string | null;
  customPathValidating: boolean;
}

interface CwdPickerActions {
  setDropdownOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  setCustomPathOpen: (v: boolean) => void;
  setCustomPathValue: (v: string) => void;
  setCustomPathError: (v: string | null) => void;
  setSelectedCwd: (cwd: string) => void;
  commitCustomPath: () => Promise<void>;
  handleDefaultCwd: () => Promise<void>;
}

interface CwdPickerRefs {
  customPathInputRef: RefObject<HTMLInputElement | null>;
  dropdownRef: RefObject<HTMLDivElement | null>;
}

export interface ProjectEntry {
  cwd: string;
  count: number;
}

interface CwdPickerProps {
  state: CwdPickerState;
  actions: CwdPickerActions;
  refs: CwdPickerRefs;
  /** All known project cwds with session counts, most recent first. */
  projects: ProjectEntry[];
  initialSessionId: string | null;
  isRestoring: boolean;
}

const lastSegment = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * Project entry point in the sidebar: a real button (name + path + chevron)
 * that opens the ProjectSwitcher modal (also on ⌘/Ctrl+P). The old
 * three-mode dropdown (list / browse / custom path) lives on inside the
 * switcher as one unified input.
 */
export function CwdPicker({ state, actions, projects, initialSessionId, isRestoring }: CwdPickerProps) {
  const { selectedCwd, homeDir, dropdownOpen } = state;
  const { setDropdownOpen, setSelectedCwd, handleDefaultCwd } = actions;
  const { t } = useI18n();

  // Validate a typed path via the existing endpoint; returns an error or null.
  const pickPath = useCallback(async (path: string): Promise<string | null> => {
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error) return data.error ?? `HTTP ${res.status}`;
      setSelectedCwd(data.cwd ?? path);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [setSelectedCwd]);

  // ⌘/Ctrl+P opens the switcher (browser print is never what you want here).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setDropdownOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setDropdownOpen]);

  useEffect(() => onOpenProjectSwitcher(() => setDropdownOpen(true)), [setDropdownOpen]);

  return (
    <>
      <button
        onClick={() => setDropdownOpen((v: boolean) => !v)}
        className={selectedCwd ? styles.trigger : styles.triggerEmpty}
        title={selectedCwd ? `${selectedCwd} (⌘P)` : `${t("cwd.select")} (⌘P)`}
        data-testid="project-switcher-trigger"
      >
        <span className={styles.triggerIcon} aria-hidden>
          <Folder size={13} aria-hidden />
        </span>
        {selectedCwd ? (
          <>
            <span className={styles.triggerName}>{lastSegment(selectedCwd)}</span>
            <span className={styles.triggerPath}>{shortenCwd(selectedCwd, homeDir)}</span>
          </>
        ) : (
          <span className={styles.triggerPlaceholder}>
            {initialSessionId && !isRestoring ? "" : t("cwd.select")}
          </span>
        )}
        <span className={styles.triggerChevron} aria-hidden>
          <ChevronDown size={10} strokeWidth={1.6} aria-hidden />
        </span>
      </button>

      <ProjectSwitcher
        open={dropdownOpen}
        onClose={() => setDropdownOpen(false)}
        onPick={setSelectedCwd}
        onPickPath={pickPath}
        onDefaultCwd={() => void handleDefaultCwd()}
        projects={projects}
        selectedCwd={selectedCwd}
        homeDir={homeDir}
      />
    </>
  );
}

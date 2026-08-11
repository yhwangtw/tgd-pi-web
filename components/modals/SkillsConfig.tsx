"use client";

import { useState, useEffect, useCallback } from "react";
import type { Skill } from "./skills-config-types";
import { shortenPath, sourceLabel } from "./skills-config-types";
import { SkillDetail } from "./SkillDetail";
import { AddSkillPanel } from "./AddSkillPanel";
import styles from "./SkillsConfig.module.css";

export function SkillsConfig({
  cwd,
  onClose,
}: {
  cwd: string;
  onClose: () => void;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [query, setQuery] = useState("");
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");

  // Esc closes the modal — consistent with AnalyticsModal and the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadSkills = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d: { skills?: Skill[]; error?: string }) => {
        if (d.error) {
          setError(d.error);
          return;
        }
        const list = d.skills ?? [];
        setSkills(list);
        if (list.length > 0 && !selected) setSelected(list[0].filePath);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cwd, selected]);

  useEffect(() => {
    loadSkills();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback(async (skill: Skill) => {
    const next = !skill.disableModelInvocation;
    setToggling((s) => new Set(s).add(skill.filePath));
    setSaveError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: skill.filePath,
          disableModelInvocation: next,
        }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setSaveError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setSkills((prev) =>
        prev.map((s) =>
          s.filePath === skill.filePath
            ? { ...s, disableModelInvocation: next }
            : s,
        ),
      );
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(skill.filePath);
        return n;
      });
    }
  }, []);

  const selectedSkill = skills.find((s) => s.filePath === selected) ?? null;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSkills = normalizedQuery
    ? skills.filter((skill) => `${skill.name} ${skill.description ?? ""} ${skill.filePath}`.toLowerCase().includes(normalizedQuery))
    : skills;

  return (
    <div className={styles.overlay}>
      <button type="button" tabIndex={-1} className={styles.overlayBackdrop} onClick={onClose} aria-label="Dismiss Skills" />
      <div
        className={styles.modal}
        data-testid="skills-config-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skills-config-title"
      >
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span id="skills-config-title" className={styles.title}>
              Skills
            </span>
            <code className={styles.cwdCode}>
              {shortenPath(cwd)}
            </code>
          </div>
          <button
            onClick={onClose}
            className={styles.closeButton}
            aria-label="Close Skills"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className={`${styles.body} ${mobilePane === "detail" ? styles.mobileDetail : styles.mobileList}`}>
          {/* Left: skill list */}
          <div className={styles.sidebar} data-testid="skills-config-nav">
            <label className={styles.searchBox}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
              </svg>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter skills…" aria-label="Filter skills" />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear skill filter">×</button>}
            </label>
            <div className={styles.sidebarScroll}>
              {loading ? (
                <div className={styles.loadingText}>
                  Loading…
                </div>
              ) : error ? (
                <div className={styles.errorText}>
                  {error}
                </div>
              ) : skills.length === 0 ? (
                <div className={styles.emptyText}>
                  No skills found
                </div>
              ) : visibleSkills.length === 0 ? (
                <div className={styles.emptyText}>
                  No matching skills
                </div>
              ) : (
                (() => {
                  const groups: { label: string; skills: typeof skills }[] = [];
                  for (const grpLabel of ["project", "global", "path"]) {
                    const grpSkills = visibleSkills.filter(
                      (s) => sourceLabel(s) === grpLabel,
                    );
                    if (grpSkills.length > 0)
                      groups.push({ label: grpLabel, skills: grpSkills });
                  }
                  return groups.map(
                    ({ label: grpLabel, skills: grpSkills }) => (
                      <div key={grpLabel} className={styles.groupContainer}>
                        <div className={styles.groupLabel}>
                          {grpLabel}
                        </div>
                        {grpSkills.map((skill) => {
                          const isSelected =
                            !addMode && selected === skill.filePath;
                          const disabled = skill.disableModelInvocation;
                          return (
                            <button
                              type="button"
                              key={skill.filePath}
                              onClick={() => {
                                setSelected(skill.filePath);
                                setAddMode(false);
                                setMobilePane("detail");
                              }}
                              className={`${styles.skillItem} ${isSelected ? styles.skillItemSelected : ""} ${!isSelected ? "hover-bg" : ""}`}
                              aria-pressed={isSelected}
                            >
                              <span
                                className={`${styles.statusDot} ${disabled ? styles.statusDotDisabled : ""}`}
                              />
                              <span
                                className={`${styles.skillName} ${isSelected ? styles.skillNameSelected : ""} ${disabled ? styles.skillNameDisabled : ""}`}
                              >
                                {skill.name}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ),
                  );
                })()
              )}
            </div>
            {/* Add skill button */}
            <div className={styles.addButtonWrapper}>
              <button
                type="button"
                onClick={() => { setAddMode(true); setMobilePane("detail"); }}
                className={`${styles.addSkillButton} ${addMode ? styles.addSkillButtonActive : ""} ${!addMode ? "hover-bg" : ""}`}
                aria-pressed={addMode}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add skill
              </button>
            </div>
          </div>

          {/* Right: detail or add panel */}
          <div className={styles.rightPanel} data-testid="skills-config-detail">
            <button type="button" className={styles.mobileBack} onClick={() => setMobilePane("list")}>
              Back to skills
            </button>
            {addMode ? (
              <AddSkillPanel
                cwd={cwd}
                onInstalled={() => {
                  loadSkills();
                }}
              />
            ) : loading ? null : selectedSkill ? (
              <SkillDetail
                key={selectedSkill.filePath}
                skill={selectedSkill}
                cwd={cwd}
                onToggle={toggle}
                toggling={toggling.has(selectedSkill.filePath)}
                saveError={saveError}
              />
            ) : (
              <div className={styles.emptyState}>
                Select a skill
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

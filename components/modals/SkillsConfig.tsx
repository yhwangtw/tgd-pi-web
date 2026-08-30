"use client";

import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Plus, Search, X } from "lucide-react";
import { DialogShell } from "@/components/ui/DialogShell";
import { IconButton } from "@/components/ui/IconButton";
import { useI18n } from "@/lib/i18n";
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
  const { t } = useI18n();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [query, setQuery] = useState("");
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");

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
  const groupLabels: Record<string, string> = {
    project: t("skills.source.project"),
    global: t("skills.source.global"),
    path: t("skills.source.path"),
  };

  return (
    <DialogShell
      open
      title={t("skills.title")}
      description={shortenPath(cwd)}
      onClose={onClose}
      size="wide"
      mobileMode="fullscreen"
      bodyClassName={styles.shellBody}
      testId="skills-config-dialog"
    >
        <div className={`${styles.layout} ${mobilePane === "detail" ? styles.mobileDetail : styles.mobileList}`}>
          {/* Left: skill list */}
          <div className={styles.sidebar} data-testid="skills-config-nav">
            <label className={styles.searchBox}>
              <Search size={15} strokeWidth={1.8} aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("skills.filterPlaceholder")}
                aria-label={t("skills.filter")}
              />
              {query && (
                <IconButton
                  label={t("skills.clearFilter")}
                  icon={<X strokeWidth={1.8} />}
                  size="compact"
                  onClick={() => setQuery("")}
                  className={styles.clearSearch}
                />
              )}
            </label>
            <div className={styles.sidebarScroll}>
              {loading ? (
                <div className={styles.loadingText}>
                  {t("common.loading")}
                </div>
              ) : error ? (
                <div className={styles.errorText}>
                  {error}
                </div>
              ) : skills.length === 0 ? (
                <div className={styles.emptyText}>
                  {t("skills.noneFound")}
                </div>
              ) : visibleSkills.length === 0 ? (
                <div className={styles.emptyText}>
                  {t("skills.noMatches")}
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
                          {groupLabels[grpLabel] ?? grpLabel}
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
                                aria-hidden="true"
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
                <Plus size={15} strokeWidth={1.8} aria-hidden="true" />
                {t("skills.add")}
              </button>
            </div>
          </div>

          {/* Right: detail or add panel */}
          <div className={styles.rightPanel} data-testid="skills-config-detail">
            <button type="button" className={styles.mobileBack} onClick={() => setMobilePane("list")}>
              <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />
              {t("skills.back")}
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
                {t("skills.select")}
              </div>
            )}
          </div>
        </div>
    </DialogShell>
  );
}

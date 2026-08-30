"use client";

import { useEffect, useState } from "react";
import type { Skill } from "./skills-config-types";
import { sourceLabel, shortenPath } from "./skills-config-types";
import { MarkdownBody } from "@/components/chat/MarkdownBody";
import { useI18n } from "@/lib/i18n";
import styles from "./SkillDetail.module.css";

export function Toggle({
  enabled,
  loading,
  onToggle,
}: {
  enabled: boolean;
  loading: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const toggleClass = loading
    ? (enabled ? styles.toggleLoading : styles.toggleLoadingDisabled)
    : (enabled ? styles.toggleEnabled : styles.toggleDisabled);

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      title={
        enabled
          ? t("skills.detail.visibleDisable")
          : t("skills.detail.hiddenEnable")
      }
      aria-label={enabled ? t("skills.detail.disable") : t("skills.detail.enable")}
      aria-pressed={enabled}
      className={`${styles.toggle} ${toggleClass}`}
    >
      <span
        className={`${styles.toggleKnob} ${enabled ? styles.toggleKnobOn : styles.toggleKnobOff}`}
      />
    </button>
  );
}

export function SkillDetail({
  skill,
  cwd,
  onToggle,
  toggling,
  saveError,
}: {
  skill: Skill;
  cwd: string;
  onToggle: (skill: Skill) => void;
  toggling: boolean;
  saveError: string | null;
}) {
  const { t } = useI18n();
  const source = sourceLabel(skill);
  const sourceText = t(`skills.source.${source}` as "skills.source.project" | "skills.source.global" | "skills.source.path");
  const enabled = !skill.disableModelInvocation;

  // SKILL.md body, fetched lazily per selected skill. The component remounts
  // per skill (key={filePath} at the call site), so plain state is enough.
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/skills?cwd=${encodeURIComponent(cwd)}&content=${encodeURIComponent(skill.filePath)}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { content?: string };
        if (!cancelled) setContent(data.content ?? "");
      } catch (e) {
        if (!cancelled) setContentError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, skill.filePath]);

  function displayPath(p: string): string {
    if (source === "project" && p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[/\\]/, "");
      return `./${rel}`;
    }
    return shortenPath(p);
  }

  return (
    <div className={styles.container}>
      <div className={styles.skillHeader}>
        <div className={styles.skillIntro}>
          <div className={styles.titleRow}>
            <h3>{skill.name}</h3>
            <span className={`${styles.tag} ${source === "project" ? styles.tagProject : styles.tagGlobal}`}>
              {sourceText}
            </span>
          </div>
          <p className={styles.fieldValueText}>{skill.description}</p>
          <div className={styles.pathRow} title={skill.filePath}>
            <span className={styles.pathText}>{displayPath(skill.filePath)}</span>
          </div>
        </div>
        <div className={styles.toggleControl}>
          <span>{enabled ? t("skills.detail.enabled") : t("skills.detail.disabled")}</span>
          <Toggle enabled={enabled} loading={toggling} onToggle={() => onToggle(skill)} />
        </div>
      </div>
      {saveError && <span className={styles.errorText}>{saveError}</span>}

      <div className={styles.fieldSection}>
        <span className={styles.fieldLabel}>
          {t("skills.detail.instructions")}
        </span>
        {contentError ? (
          <span className={styles.errorText}>{contentError}</span>
        ) : content === null ? (
          <span className={styles.fieldValueText} role="status">{t("common.loading")}</span>
        ) : content.trim() === "" ? (
          <span className={styles.fieldValueText}>{t("skills.detail.empty")}</span>
        ) : (
          <div className={styles.contentBox}>
            <MarkdownBody className="markdown-file-preview">{content}</MarkdownBody>
          </div>
        )}
      </div>
    </div>
  );
}

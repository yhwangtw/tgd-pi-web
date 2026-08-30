"use client";

import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import styles from "./TgdPipeline.module.css";
import { useI18n } from "@/lib/i18n";

export type PhaseStatus = "done" | "current" | "todo";

export interface TgdPhase {
  cmd: string;
  label: string;
  desc: string;
  icon: ReactNode;
}

interface Props {
  phases: TgdPhase[];
  statusOf: (cmd: string) => PhaseStatus;
  onRun: (cmd: string) => void;
  /** Name of the feature whose progress the bar reflects, if known. */
  feature?: string | null;
  /** Hide the whole bar (persisted by the parent). */
  onHide?: () => void;
  /** Expand while a tGD command is the active run. */
  active?: boolean;
}

/**
 * Compact tGD workflow pipeline. Each phase reflects real progress:
 * map/define/plan are marked done when their artifacts exist on disk, the later
 * phases when their command has run this session; the live phase is "current"
 * and the rest are "todo". Clicking a phase drops its command into the composer.
 */
export function TgdPipeline({ phases, statusOf, onRun, feature, onHide, active = false }: Props) {
  const { t } = useI18n();
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const phaseListId = useId();
  const current = phases.find((phase) => statusOf(phase.cmd) === "current")
    ?? phases.find((phase) => statusOf(phase.cmd) === "todo")
    ?? phases.at(-1);
  const doneCount = phases.filter((phase) => statusOf(phase.cmd) === "done").length;
  const expanded = active || manuallyExpanded;

  return (
    <div className={styles.bar}>
      <span className={styles.brand}>tGD</span>
      {feature && <span className={styles.feature} title={`${t("chat.trackingFeature")}: ${feature}`}>{feature}</span>}
      {current && (
        <button
          type="button"
          className={styles.mobileSummary}
          onClick={() => setManuallyExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={phaseListId}
        >
          <span className={styles.mobileCurrent}>
            <span className={styles.mobileCurrentLabel}>{current.label}</span>
            {feature && <span className={styles.mobileFeature}>{feature}</span>}
          </span>
          <span className={styles.mobileProgress}>{doneCount}/{phases.length}</span>
          <ChevronDown className={`${styles.mobileChevron} ${expanded ? styles.mobileChevronOpen : ""}`} size={13} aria-hidden />
        </button>
      )}
      <div id={phaseListId} className={`${styles.track} ${expanded ? styles.trackOpen : ""}`}>
        {phases.map((phase, i) => {
          const status = statusOf(phase.cmd);
          return (
            <div key={phase.cmd} className={styles.step}>
              {i > 0 && <span className={`${styles.connector} ${styles[`conn_${status}`]}`} />}
              <button
                onClick={() => { onRun(phase.cmd); setManuallyExpanded(false); }}
                className={`${styles.phase} ${styles[status]}`}
                title={`${phase.cmd} — ${phase.desc}`}
                aria-current={status === "current" ? "step" : undefined}
              >
                <span className={styles.icon} aria-hidden>
                  {status === "done" ? (
                    <Check size={12} strokeWidth={3} />
                  ) : phase.icon}
                </span>
                <span className={styles.label}>{phase.label}</span>
              </button>
            </div>
          );
        })}
      </div>
      {onHide && (
        <button onClick={onHide} className={styles.hide} title={t("chat.hidePipeline")} aria-label={t("chat.hidePipeline")}>
          <X size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}

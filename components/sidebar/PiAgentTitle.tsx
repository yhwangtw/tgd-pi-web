"use client";

import { useI18n } from "@/lib/i18n";
import styles from "./PiAgentTitle.module.css";

/**
 * App wordmark: π in a gradient badge + a two-line lockup.
 * Colors come from the active skin's accent tokens, so the mark re-themes
 * with every appearance.
 */
export function PiAgentTitle() {
  const { t } = useI18n();
  return (
    <span className={styles.lockup}>
      <span className={styles.badge} aria-hidden>
        π
      </span>
      <span className={styles.textCol}>
        <span className={styles.name}>with tGD</span>
        <span className={styles.tagline}>{t("brand.codingAgent")}</span>
      </span>
    </span>
  );
}

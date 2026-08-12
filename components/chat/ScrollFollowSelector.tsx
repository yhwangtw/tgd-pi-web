"use client";

import { useI18n, type MsgKey } from "@/lib/i18n";
import {
  SCROLL_FOLLOW_MODES,
  setScrollFollowMode,
  useScrollFollowMode,
  type ScrollFollowMode,
} from "@/lib/prefs";
import styles from "./ScrollFollowSelector.module.css";

const LABEL_KEYS: Record<ScrollFollowMode, MsgKey> = {
  smart: "input.scrollMode.smart",
  always: "input.scrollMode.always",
  preserve: "input.scrollMode.preserve",
};

const DESCRIPTION_KEYS: Record<ScrollFollowMode, MsgKey> = {
  smart: "input.scrollModeDesc.smart",
  always: "input.scrollModeDesc.always",
  preserve: "input.scrollModeDesc.preserve",
};

export function ScrollFollowSelector() {
  const { t } = useI18n();
  const mode = useScrollFollowMode();

  return (
    <div className={styles.group} role="radiogroup" aria-label={t("input.scrollModeTitle")}>
      {SCROLL_FOLLOW_MODES.map((option) => {
        const active = option === mode;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            className={`${styles.option} ${active ? styles.optionActive : ""}`}
            onClick={() => setScrollFollowMode(option)}
            title={t(DESCRIPTION_KEYS[option])}
          >
            <span className={styles.dot} aria-hidden />
            <span>{t(LABEL_KEYS[option])}</span>
          </button>
        );
      })}
    </div>
  );
}

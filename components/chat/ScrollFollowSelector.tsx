"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import { useI18n, type MsgKey } from "@/lib/i18n";
import {
  SCROLL_FOLLOW_MODES,
  setScrollFollowMode,
  useScrollFollowMode,
  type ScrollFollowMode,
} from "@/lib/prefs";
import { ArrowDownToLine, MousePointer2, Pause } from "lucide-react";
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

const ICONS = { smart: MousePointer2, always: ArrowDownToLine, preserve: Pause };

export function ScrollFollowSelector({ iconOnly = false }: { iconOnly?: boolean }) {
  const { t } = useI18n();
  const mode = useScrollFollowMode();

  return (
    <div className={`${styles.group} ${iconOnly ? styles.iconGroup : ""}`} role="radiogroup" aria-label={t("input.scrollModeTitle")}>
      {SCROLL_FOLLOW_MODES.map((option) => {
        const active = option === mode;
        const Icon = ICONS[option];
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={t(LABEL_KEYS[option])}
            tabIndex={active ? 0 : -1}
            onKeyDown={(event) => {
              const index = SCROLL_FOLLOW_MODES.indexOf(option);
              const next = event.key === "Home" ? 0 : event.key === "End" ? SCROLL_FOLLOW_MODES.length - 1
                : ["ArrowRight", "ArrowDown"].includes(event.key) ? (index + 1) % SCROLL_FOLLOW_MODES.length
                  : ["ArrowLeft", "ArrowUp"].includes(event.key) ? (index + SCROLL_FOLLOW_MODES.length - 1) % SCROLL_FOLLOW_MODES.length : null;
              if (next === null) return;
              event.preventDefault();
              setScrollFollowMode(SCROLL_FOLLOW_MODES[next]);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
            }}
            className={`${styles.option} ${active ? styles.optionActive : ""}`}
            onClick={() => setScrollFollowMode(option)}
            title={`${t(LABEL_KEYS[option])} — ${t(DESCRIPTION_KEYS[option])}`}
          >
            <Icon size={UI_ICON_SIZE.control} aria-hidden="true" />
            {!iconOnly && <span>{t(LABEL_KEYS[option])}</span>}
          </button>
        );
      })}
    </div>
  );
}

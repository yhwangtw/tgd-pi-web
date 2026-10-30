"use client";
import { UI_ICON_SIZE } from "@/lib/ui-icons";

import React, { useState, useRef, useEffect, useId } from "react";
import { Check, Lightbulb } from "lucide-react";
import { THINKING_LEVELS, type ThinkingLevelOption } from "./chat-input-constants";
import { useI18n, type MsgKey } from "@/lib/i18n";
import { useComposerPopupPosition } from "./useComposerPopupPosition";
import styles from "./ComposerSelector.module.css";
import { announceComposerSelectorOpen, onAnotherComposerSelectorOpen } from "./composer-selector-coordination";

const THINKING_LABEL_KEYS: Record<ThinkingLevelOption, MsgKey> = {
  auto: "input.thinking.auto",
  off: "input.thinking.off",
  minimal: "input.thinking.minimal",
  low: "input.thinking.low",
  medium: "input.thinking.medium",
  high: "input.thinking.high",
  xhigh: "input.thinking.xhigh",
  max: "input.thinking.max",
};

const THINKING_DESC_KEYS: Record<ThinkingLevelOption, MsgKey> = {
  auto: "input.thinkingDesc.auto",
  off: "input.thinkingDesc.off",
  minimal: "input.thinkingDesc.minimal",
  low: "input.thinkingDesc.low",
  medium: "input.thinkingDesc.medium",
  high: "input.thinkingDesc.high",
  xhigh: "input.thinkingDesc.xhigh",
  max: "input.thinkingDesc.max",
};

interface ThinkingSelectorProps {
  thinkingLevel?: ThinkingLevelOption;
  thinkingLevelMap?: Record<string, string | null> | null;
  availableThinkingLevels?: string[] | null;
  isStreaming: boolean;
  disabled?: boolean;
  presentation?: "popover" | "inline";
  iconOnly?: boolean;
  onThinkingLevelChange?: (level: ThinkingLevelOption) => void;
}

export function ThinkingSelector({
  thinkingLevel,
  thinkingLevelMap,
  availableThinkingLevels,
  disabled = false,
  presentation = "popover",
  iconOnly = false,
  onThinkingLevelChange,
}: ThinkingSelectorProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const panelRef = useComposerPopupPosition(open && presentation === "popover", triggerRef);

  useEffect(() => onAnotherComposerSelectorOpen(listboxId, () => setOpen(false)), [listboxId]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!onThinkingLevelChange) return null;
  const level = thinkingLevel ?? "auto";
  const currentLabel = level === "auto" || !thinkingLevelMap
    ? t(THINKING_LABEL_KEYS[level]) : thinkingLevelMap[level] ?? t(THINKING_LABEL_KEYS[level]);

  return (
    <div
      ref={ref}
      className={`${styles.root} ${presentation === "inline" ? styles.inlineRoot : ""}`}
      data-inline-selector-open={presentation === "inline" && open ? "true" : undefined}
    >
      <button
        ref={triggerRef}
        onClick={() => {
          if (disabled) return;
          if (!open) announceComposerSelectorOpen(listboxId);
          setOpen(!open);
        }}
        disabled={disabled}
        type="button"
        aria-label={t("input.thinkingTitle")}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        title={`${t("input.reasoning")}: ${currentLabel}`}
        aria-describedby={`${listboxId}-value`}
        className={`${styles.trigger} ${iconOnly ? styles.iconTrigger : ""} ${open ? styles.triggerOpen : ""}`}
      >
        <Lightbulb size={UI_ICON_SIZE.control} aria-hidden />
        {!iconOnly && <span>{currentLabel}</span>}
      </button>
      <span id={`${listboxId}-value`} hidden>{currentLabel}</span>
      {open && (
        <div
          ref={panelRef}
          id={listboxId}
          className={`${styles.panel} ${presentation === "inline" ? styles.panelInline : styles.panelAbsolute}`}
          role="listbox"
          aria-label={t("input.thinkingTitle")}
        >
          {THINKING_LEVELS.filter((lvl) => {
            if (!availableThinkingLevels) return lvl !== "max" || typeof thinkingLevelMap?.max === "string";
            if (lvl === "auto") return true;
            return availableThinkingLevels.includes(lvl);
          }).map((lvl) => {
            const isActive = (thinkingLevel ?? "auto") === lvl;
            const desc = t(THINKING_DESC_KEYS[lvl]);
            const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
            const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : t(THINKING_LABEL_KEYS[lvl]);
            const showOriginal = mappedVal != null && mappedVal !== lvl;
            return (
              <button
                key={lvl}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  if (disabled) return;
                  setOpen(false);
                  if (!isActive) onThinkingLevelChange(lvl);
                  requestAnimationFrame(() => triggerRef.current?.focus());
                }}
                className={`${styles.option} ${isActive ? styles.optionActive : ""}`}
              >
                {isActive
                  ? <Check className={styles.check} size={UI_ICON_SIZE.inline} aria-hidden />
                  : <span className={styles.checkSpacer} />}
                <span className={styles.optionLabel}>
                  {displayLabel}
                  {showOriginal && <span className={styles.originalLabel}>({lvl})</span>}
                </span>
                <span className={styles.description}>{desc}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

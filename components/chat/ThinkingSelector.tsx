"use client";

import React, { useState, useRef, useEffect, useId } from "react";
import { Check, Lightbulb } from "lucide-react";
import { THINKING_LEVELS, type ThinkingLevelOption } from "./chat-input-constants";
import { useI18n, type MsgKey } from "@/lib/i18n";
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
};

const THINKING_DESC_KEYS: Record<ThinkingLevelOption, MsgKey> = {
  auto: "input.thinkingDesc.auto",
  off: "input.thinkingDesc.off",
  minimal: "input.thinkingDesc.minimal",
  low: "input.thinkingDesc.low",
  medium: "input.thinkingDesc.medium",
  high: "input.thinkingDesc.high",
  xhigh: "input.thinkingDesc.xhigh",
};

interface ThinkingSelectorProps {
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  thinkingLevelMap?: Record<string, string | null> | null;
  availableThinkingLevels?: string[] | null;
  isStreaming: boolean;
  presentation?: "popover" | "inline";
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh") => void;
}

export function ThinkingSelector({
  thinkingLevel,
  thinkingLevelMap,
  availableThinkingLevels,
  isStreaming,
  presentation = "popover",
  onThinkingLevelChange,
}: ThinkingSelectorProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  useEffect(() => onAnotherComposerSelectorOpen(listboxId, () => setOpen(false)), [listboxId]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!onThinkingLevelChange) return null;

  return (
    <div
      ref={ref}
      className={`${styles.root} ${presentation === "inline" ? styles.inlineRoot : ""}`}
      data-inline-selector-open={presentation === "inline" && open ? "true" : undefined}
    >
      <button
        ref={triggerRef}
        onClick={() => {
          if (isStreaming) return;
          if (!open) announceComposerSelectorOpen(listboxId);
          setOpen(!open);
        }}
        disabled={isStreaming}
        type="button"
        aria-label={t("input.thinkingTitle")}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        title={t("input.thinkingTitle")}
        className={`${styles.trigger} ${open ? styles.triggerOpen : ""}`}
      >
        <Lightbulb size={11} aria-hidden />
        <span>{(() => {
          const lvl = thinkingLevel ?? "auto";
          if (lvl === "auto" || !thinkingLevelMap) return t(THINKING_LABEL_KEYS[lvl]);
          const mapped = thinkingLevelMap[lvl];
          return mapped != null ? mapped : t(THINKING_LABEL_KEYS[lvl]);
        })()}</span>
      </button>
      {open && (
        <div
          id={listboxId}
          className={`${styles.panel} ${presentation === "inline" ? styles.panelInline : styles.panelAbsolute}`}
          role="listbox"
          aria-label={t("input.thinkingTitle")}
        >
          {THINKING_LEVELS.filter((lvl) => {
            if (!availableThinkingLevels) return true;
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
                  setOpen(false);
                  if (!isActive) onThinkingLevelChange(lvl);
                  requestAnimationFrame(() => triggerRef.current?.focus());
                }}
                className={`${styles.option} ${isActive ? styles.optionActive : ""}`}
              >
                {isActive
                  ? <Check className={styles.check} size={10} strokeWidth={2} aria-hidden />
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
